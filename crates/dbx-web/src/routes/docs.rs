use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use dbx_core::docs::{CollectOptions, SchemaSnapshot};
use dbx_core::models::connection::ConnectionConfig;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsSnapshotRequest {
    pub connection_id: String,
    pub database: String,
    #[serde(default)]
    pub schemas: Vec<String>,
    #[serde(default)]
    pub tables: Vec<String>,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub max_concurrent_tables: Option<usize>,
}

async fn load_connection(state: &Arc<WebState>, connection_id: &str) -> Result<ConnectionConfig, AppError> {
    state
        .app
        .storage
        .load_connections()
        .await
        .map_err(AppError::from)?
        .into_iter()
        .find(|config| config.id == connection_id)
        .ok_or_else(|| AppError::from(format!("Connection with id '{connection_id}' not found")))
}

pub async fn collect_snapshot(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DocsSnapshotRequest>,
) -> Result<Json<SchemaSnapshot>, AppError> {
    let connection = load_connection(&state, &request.connection_id).await?;

    let options = CollectOptions {
        database: request.database.clone(),
        schemas: request.schemas.clone(),
        tables: request.tables.clone(),
        project_name: request.project_name.clone().unwrap_or_else(|| connection.name.clone()),
    };

    let snapshot = dbx_core::docs::collect_snapshot_with_concurrency(
        &state.app,
        &connection,
        &options,
        &|_progress| {},
        &AtomicBool::new(false),
        request.max_concurrent_tables.unwrap_or(8).clamp(1, 8),
    )
    .await
    .map_err(AppError::from)?;

    Ok(Json(snapshot))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsAnnotationsRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsApplyRequest {
    pub connection_id: String,
    pub snapshot: SchemaSnapshot,
    pub annotations: dbx_core::docs::annotations::AnnotationFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsSaveRequest {
    pub connection_id: String,
    pub annotations: dbx_core::docs::annotations::AnnotationFile,
}

/// `WebState` already carries the data directory (`pub data_dir: PathBuf`), so
/// this needs no lookup and no new dependency — dbx-web does NOT depend on
/// dbx-mcp.
///
/// On the HTTP surface an explicit connection-level `docsNotesPath` is a
/// drive-by arbitrary-path write primitive: `/api/connection/save` stores it
/// verbatim and `annotations/save` then creates and overwrites whatever it
/// points at, with the server process's permissions. The desktop keeps its
/// "point notes at a repo file" flow; the server confines notes under
/// `data_dir/docs-notes` unless the operator explicitly allowlists additional
/// roots via `DBX_DOCS_NOTES_ROOTS` (colon-separated, absolute).
fn notes_path_for(state: &Arc<WebState>, config: &ConnectionConfig) -> Result<std::path::PathBuf, AppError> {
    let explicit = config.docs_notes_path.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let Some(explicit) = explicit else {
        return Ok(dbx_core::docs::annotations::resolve_notes_path(&config.id, None, &state.data_dir));
    };
    let default_root = state.data_dir.join("docs-notes");
    let candidate = std::path::PathBuf::from(explicit);
    let contained = if candidate.is_absolute() {
        // `..` inside an allowed root is rejected outright (normalize-within
        // semantics); operators who need traversal shapes can point the root
        // at the exact directory instead.
        NOTES_ROOTS
            .get_or_init(|| parse_notes_roots(std::env::var("DBX_DOCS_NOTES_ROOTS").ok().as_deref()))
            .iter()
            .chain(std::iter::once(&default_root))
            .find_map(|root| normalize_within(root, &candidate))
    } else {
        normalize_within(&default_root, &candidate)
    };
    contained.ok_or_else(|| {
        AppError::from(format!(
            "docsNotesPath \"{explicit}\" is outside the allowed notes roots; set DBX_DOCS_NOTES_ROOTS to allow this server's notes to live elsewhere"
        ))
    })
}

/// Allowlist roots are deployment-static: read once, not per request.
fn parse_notes_roots(raw: Option<&str>) -> Vec<std::path::PathBuf> {
    raw.map(|value| {
        value
            .split(':')
            .map(str::trim)
            .filter(|root| !root.is_empty())
            .map(std::path::PathBuf::from)
            .filter(|root| root.is_absolute())
            .collect()
    })
    .unwrap_or_default()
}

/// Joins `candidate` under `base` rejecting every component that could leave
/// it (`..`, absolute prefixes). No symlink resolution: notes files are
/// host-authored JSON, and create_dir_all would otherwise follow an attacker
/// planted link — the containment boundary is the component check.
fn normalize_within(base: &std::path::Path, candidate: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::path::Component;
    let mut result = base.to_path_buf();
    for component in candidate.components() {
        match component {
            Component::Normal(segment) => result.push(segment),
            // 冗余的 `./` 跳过；`..`/绝对前缀一律拒绝
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(result)
}

static NOTES_ROOTS: std::sync::OnceLock<Vec<std::path::PathBuf>> = std::sync::OnceLock::new();

pub async fn load_annotations(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DocsAnnotationsRequest>,
) -> Result<Json<Option<dbx_core::docs::annotations::AnnotationFile>>, AppError> {
    let config = load_connection(&state, &request.connection_id).await?;
    let path = notes_path_for(&state, &config)?;
    Ok(Json(dbx_core::docs::annotations::load_annotations(&path).map_err(AppError::from)?))
}

pub async fn apply_annotations(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DocsApplyRequest>,
) -> Result<Json<SchemaSnapshot>, AppError> {
    let config = load_connection(&state, &request.connection_id).await?;
    let mut applied = request.snapshot;
    dbx_core::docs::annotations::apply_annotations(&mut applied, &request.annotations, config.db_type);
    Ok(Json(applied))
}

pub async fn save_annotations(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DocsSaveRequest>,
) -> Result<Json<()>, AppError> {
    let config = load_connection(&state, &request.connection_id).await?;
    let path = notes_path_for(&state, &config)?;
    dbx_core::docs::annotations::save_annotations(&path, &request.annotations).map_err(AppError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsExportRequest {
    pub snapshot: SchemaSnapshot,
    pub annotations: dbx_core::docs::annotations::AnnotationFile,
    pub lang: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsExportResponse {
    pub content: String,
}

/// Returns the rendered HTML as a string rather than writing a file: the
/// browser has no filesystem to write to, so `http.ts` downloads this content
/// as a blob instead of the Tauri command's `std::fs::write`.
pub async fn export_html(Json(request): Json<DocsExportRequest>) -> Result<Json<DocsExportResponse>, AppError> {
    let content = dbx_core::docs::to_standalone_html(&request.snapshot, &request.annotations, &request.lang)
        .map_err(AppError::from)?;
    Ok(Json(DocsExportResponse { content }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn connection_with_notes_path(path: Option<&str>) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "conn-1", "name": "n", "dbType": "postgres",
            "host": "", "port": 0, "username": "", "password": "",
            "docsNotesPath": path,
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn notes_paths_stay_inside_the_data_dir_by_default() {
        let directory = tempfile::tempdir().unwrap();
        let storage =
            dbx_core::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db")).await.unwrap();
        let state = std::sync::Arc::new(WebState::for_tests(
            std::sync::Arc::new(dbx_core::connection::AppState::new(storage)),
            directory.path().to_path_buf(),
        ));

        // 未配置 docsNotesPath 时使用默认的 data_dir/docs-notes/<id>.json。
        let config = connection_with_notes_path(None);
        let path = notes_path_for(&state, &config).unwrap();
        assert_eq!(path, directory.path().join("docs-notes").join("conn-1.json"));

        // 指向 docs-notes 内部的相对路径可用（仓库笔记工作流的受控形态）。
        let config = connection_with_notes_path(Some("repo/notes.json"));
        let path = notes_path_for(&state, &config).unwrap();
        assert_eq!(path, directory.path().join("docs-notes").join("repo").join("notes.json"));

        // ../ 逃逸与绝对路径都拒绝：settings 写入不得变成任意文件覆盖。
        let escaping = connection_with_notes_path(Some("../escape.json"));
        assert!(notes_path_for(&state, &escaping).is_err());
        let absolute = connection_with_notes_path(Some("/etc/dbx-notes.json"));
        assert!(notes_path_for(&state, &absolute).is_err());
    }

    #[test]
    fn allowlisted_roots_parse_strictly() {
        assert_eq!(parse_notes_roots(None), Vec::<PathBuf>::new());
        assert_eq!(parse_notes_roots(Some("")), Vec::<PathBuf>::new());
        assert_eq!(parse_notes_roots(Some("relative/path")), Vec::<PathBuf>::new(), "roots must be absolute");
        assert_eq!(
            parse_notes_roots(Some("/srv/notes:/tmp/x")),
            vec![PathBuf::from("/srv/notes"), PathBuf::from("/tmp/x")]
        );
    }

    #[test]
    fn normalize_within_rejects_parent_and_root_components() {
        let base = PathBuf::from("/srv/notes");
        assert_eq!(normalize_within(&base, Path::new("a/b.json")), Some(base.join("a").join("b.json")));
        assert_eq!(normalize_within(&base, Path::new("../x")), None);
        assert_eq!(normalize_within(&base, Path::new("/etc/passwd")), None);
    }
}

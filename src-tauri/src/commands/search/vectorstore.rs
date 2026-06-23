use arrow_array::{
    ArrayRef, FixedSizeListArray, Float32Array, RecordBatch, StringArray, UInt32Array,
};
use arrow_schema::{DataType, Field, Schema};
use lancedb::connect;
use lancedb::query::{ExecutableQuery, QueryBase};
use lancedb::table::optimize::OptimizeAction;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::LazyLock;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::panic_guard::run_guarded_async;

/// v1 per-page result (legacy — kept so pre-0.3.11 projects still load).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VectorSearchResult {
    pub page_id: String,
    pub score: f32,
}

/// v2 per-chunk result. Surfaces the matching chunk's text + heading path
/// so the chat UI can show "matched in this section" and aggregators on
/// the TS side can group by page_id.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChunkSearchResult {
    pub chunk_id: String,
    pub page_id: String,
    pub chunk_index: u32,
    pub chunk_text: String,
    pub heading_path: String,
    pub score: f32,
}

/// Input row for `vector_upsert_chunks`. TypeScript side owns the
/// chunk_index / chunk_text / heading_path; the Rust side is purely
/// storage. `chunk_id` is always derived as `${page_id}#${chunk_index}`
/// so we don't trust a client-supplied id.
#[derive(Debug, Deserialize)]
pub struct ChunkUpsertInput {
    pub chunk_index: u32,
    pub chunk_text: String,
    pub heading_path: String,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Deserialize)]
pub struct PageChunksReplaceInput {
    pub page_id: String,
    pub chunks: Vec<ChunkUpsertInput>,
}

fn db_path(project_path: &str) -> String {
    format!("{}/.llm-wiki/lancedb", project_path.replace('\\', "/"))
}

fn table_dir(project_path: &str, table_name: &str) -> PathBuf {
    Path::new(&db_path(project_path)).join(format!("{table_name}.lance"))
}

fn format_replace_restore_failed_error(
    final_dir: &Path,
    backup_dir: &Path,
    temp_dir: &Path,
    replace_error: &std::io::Error,
    restore_error: &std::io::Error,
) -> String {
    format!(
        "Replace chunks error: failed to move replacement table into place ({replace_error}); \
failed to restore previous table from backup ({restore_error}). \
Old table may still be available at backup path: {}; final path: {}; temp path: {}",
        backup_dir.display(),
        final_dir.display(),
        temp_dir.display()
    )
}

fn format_replace_no_backup_failed_error(
    final_dir: &Path,
    temp_dir: &Path,
    replace_error: &std::io::Error,
) -> String {
    format!(
        "Replace chunks error: failed to move replacement table into place ({replace_error}); \
final path: {}; temp path: {}",
        final_dir.display(),
        temp_dir.display()
    )
}

fn cleanup_failed_replacement_temp_dir(temp_dir: &Path) {
    let _ = std::fs::remove_dir_all(temp_dir);
}

/// v1 (legacy) table name. One row per page.
const TABLE_V1: &str = "wiki_vectors";
/// v2 (current) table name. One row per CHUNK — a page is typically
/// represented by multiple rows sharing the same `page_id`.
const TABLE_V2: &str = "wiki_chunks_v2";
const MAX_PAGE_ID_LEN: usize = 2048;

static PROJECT_LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

async fn project_vector_lock(project_path: &str) -> Arc<Mutex<()>> {
    let key = project_path.replace('\\', "/");
    let mut locks = PROJECT_LOCKS.lock().await;
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn validate_page_id_chars(page_id: &str) -> Result<(), String> {
    if page_id.is_empty() || page_id.len() > MAX_PAGE_ID_LEN {
        return Err("Invalid page_id: empty or too long".to_string());
    }
    if page_id.chars().any(|c| {
        c.is_control() || c.is_whitespace() || matches!(c, '\'' | '"' | '`' | '/' | '\\' | ';')
    }) {
        return Err(format!(
            "Invalid page_id: contains disallowed characters: {}",
            page_id
        ));
    }
    Ok(())
}

/// Validate page_id to prevent filter injection
fn validate_page_id(page_id: &str) -> Result<(), String> {
    validate_page_id_chars(page_id)
}

fn make_schema(dim: i32) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("page_id", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim),
            false,
        ),
    ]))
}

fn make_batch(
    schema: Arc<Schema>,
    page_id: &str,
    embedding: Vec<f32>,
    dim: i32,
) -> Result<RecordBatch, String> {
    let ids: ArrayRef = Arc::new(StringArray::from(vec![page_id]));
    let values = Float32Array::from(embedding);
    let vector: ArrayRef = Arc::new(FixedSizeListArray::new(
        Arc::new(Field::new("item", DataType::Float32, true)),
        dim,
        Arc::new(values),
        None,
    ));
    RecordBatch::try_new(schema, vec![ids, vector]).map_err(|e| format!("Batch error: {e}"))
}

/// Upsert a page embedding into LanceDB
#[tauri::command]
pub async fn vector_upsert(
    project_path: String,
    page_id: String,
    embedding: Vec<f32>,
) -> Result<(), String> {
    run_guarded_async("vector_upsert", async move {
        validate_page_id(&page_id)?;
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let dim = embedding.len() as i32;
        let schema = make_schema(dim);
        let batch = make_batch(schema.clone(), &page_id, embedding, dim)?;
        let data = vec![batch];

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if tables.contains(&TABLE_V1.to_string()) {
            let table = db
                .open_table(TABLE_V1)
                .execute()
                .await
                .map_err(|e| format!("Open table error: {e}"))?;

            // Delete existing entry then add new one
            if let Err(e) = table.delete(&format!("page_id = '{}'", page_id)).await {
                eprintln!(
                    "[vectorstore] Warning: delete before upsert failed for '{}': {}",
                    page_id, e
                );
            }

            table
                .add(data)
                .execute()
                .await
                .map_err(|e| format!("Add error: {e}"))?;
        } else {
            db.create_table(TABLE_V1, data)
                .execute()
                .await
                .map_err(|e| format!("Create table error: {e}"))?;
        }

        Ok(())
    })
    .await
}

/// Search for similar pages by embedding vector
#[tauri::command]
pub async fn vector_search(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
) -> Result<Vec<VectorSearchResult>, String> {
    run_guarded_async("vector_search", async move {
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V1.to_string()) {
            return Ok(vec![]);
        }

        let table = db
            .open_table(TABLE_V1)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        let results_stream = table
            .vector_search(query_embedding)
            .map_err(|e| format!("Search error: {e}"))?
            .limit(top_k)
            .execute()
            .await
            .map_err(|e| format!("Execute search error: {e}"))?;

        let mut search_results = Vec::new();

        use futures::TryStreamExt;
        let batches: Vec<RecordBatch> = results_stream
            .try_collect()
            .await
            .map_err(|e| format!("Collect error: {e}"))?;

        for batch in &batches {
            let ids = batch
                .column_by_name("page_id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or("Missing page_id column")?;

            let distances = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
                .ok_or("Missing _distance column")?;

            for i in 0..batch.num_rows() {
                let page_id = ids.value(i).to_string();
                let distance = distances.value(i);
                let score = 1.0 / (1.0 + distance);
                search_results.push(VectorSearchResult { page_id, score });
            }
        }

        Ok(search_results)
    })
    .await
}

/// Delete a page from the vector index
#[tauri::command]
pub async fn vector_delete(project_path: String, page_id: String) -> Result<(), String> {
    run_guarded_async("vector_delete", async move {
        validate_page_id(&page_id)?;
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V1.to_string()) {
            return Ok(());
        }

        let table = db
            .open_table(TABLE_V1)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        table
            .delete(&format!("page_id = '{}'", page_id))
            .await
            .map_err(|e| format!("Delete error: {e}"))?;

        Ok(())
    })
    .await
}

/// Get count of indexed vectors
#[tauri::command]
pub async fn vector_count(project_path: String) -> Result<usize, String> {
    run_guarded_async("vector_count", async move {
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V1.to_string()) {
            return Ok(0);
        }

        let table = db
            .open_table(TABLE_V1)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        let count = table
            .count_rows(None)
            .await
            .map_err(|e| format!("Count error: {e}"))?;

        Ok(count)
    })
    .await
}

// ──────────────────────────────────────────────────────────────────────────
// v2 chunk-level vector store
//
// Each row is one CHUNK of a wiki page. Multiple rows per page are the
// common case. The v2 schema:
//
//   chunk_id      Utf8       "${page_id}#${chunk_index}"   (debug-only; we
//                                                          never filter on
//                                                          this — all
//                                                          mutations scope
//                                                          by page_id)
//   page_id       Utf8       which page this chunk belongs to
//   chunk_index   UInt32     0-based position within the page
//   chunk_text    Utf8       raw chunk content (for UI re-ranking + showing
//                            "matched in this section")
//   heading_path  Utf8       breadcrumb ("## A > ### B") — empty string when
//                            the chunk lives above any heading
//   vector        FixedSizeList<Float32, dim>
//
// Upsert semantics: we DELETE every row with the target page_id and then
// ADD all the new chunks in one batch. Chunk indexes may shift when a
// page is re-ingested (content shrinks / grows / re-splits), so we never
// try to match-and-update by chunk_id — the clean-slate replace is both
// simpler and always correct.
//
// Search returns top-K CHUNKS. The TS layer aggregates to per-page scores
// (max + weighted tail) for the existing page-oriented retrieval API,
// plus exposes the chunk metadata for a future "matched in X section" UI.
// ──────────────────────────────────────────────────────────────────────────

fn validate_page_id_for_v2(page_id: &str) -> Result<(), String> {
    validate_page_id_chars(page_id)
}

fn make_schema_v2(dim: i32) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("chunk_id", DataType::Utf8, false),
        Field::new("page_id", DataType::Utf8, false),
        Field::new("chunk_index", DataType::UInt32, false),
        Field::new("chunk_text", DataType::Utf8, false),
        Field::new("heading_path", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim),
            false,
        ),
    ]))
}

fn make_batch_v2(
    schema: Arc<Schema>,
    page_id: &str,
    chunks: &[ChunkUpsertInput],
    dim: i32,
) -> Result<RecordBatch, String> {
    let mut chunk_ids: Vec<String> = Vec::with_capacity(chunks.len());
    let mut page_ids: Vec<String> = Vec::with_capacity(chunks.len());
    let mut indexes: Vec<u32> = Vec::with_capacity(chunks.len());
    let mut texts: Vec<String> = Vec::with_capacity(chunks.len());
    let mut heading_paths: Vec<String> = Vec::with_capacity(chunks.len());
    let mut flat_vectors: Vec<f32> = Vec::with_capacity(chunks.len() * dim as usize);

    for c in chunks {
        if c.embedding.len() as i32 != dim {
            return Err(format!(
                "Chunk #{} has embedding dim {} but batch dim is {}",
                c.chunk_index,
                c.embedding.len(),
                dim
            ));
        }
        chunk_ids.push(format!("{}#{}", page_id, c.chunk_index));
        page_ids.push(page_id.to_string());
        indexes.push(c.chunk_index);
        texts.push(c.chunk_text.clone());
        heading_paths.push(c.heading_path.clone());
        flat_vectors.extend_from_slice(&c.embedding);
    }

    let chunk_ids_arr: ArrayRef = Arc::new(StringArray::from(chunk_ids));
    let page_ids_arr: ArrayRef = Arc::new(StringArray::from(page_ids));
    let indexes_arr: ArrayRef = Arc::new(UInt32Array::from(indexes));
    let texts_arr: ArrayRef = Arc::new(StringArray::from(texts));
    let heading_paths_arr: ArrayRef = Arc::new(StringArray::from(heading_paths));

    let values = Float32Array::from(flat_vectors);
    let vector_arr: ArrayRef = Arc::new(FixedSizeListArray::new(
        Arc::new(Field::new("item", DataType::Float32, true)),
        dim,
        Arc::new(values),
        None,
    ));

    RecordBatch::try_new(
        schema,
        vec![
            chunk_ids_arr,
            page_ids_arr,
            indexes_arr,
            texts_arr,
            heading_paths_arr,
            vector_arr,
        ],
    )
    .map_err(|e| format!("Batch error: {e}"))
}

/// Upsert a batch of chunks for a single page. Existing chunks for this
/// page are deleted first so the on-disk state reflects the latest split.
/// An empty `chunks` argument is a no-op — it does NOT clear the page's
/// existing index (for that, call `vector_delete_page` explicitly), so
/// transient ingest failures don't nuke previously-good embeddings.
#[tauri::command]
pub async fn vector_upsert_chunks(
    project_path: String,
    page_id: String,
    chunks: Vec<ChunkUpsertInput>,
) -> Result<(), String> {
    run_guarded_async("vector_upsert_chunks", async move {
        validate_page_id_for_v2(&page_id)?;
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;

        if chunks.is_empty() {
            return Ok(());
        }

        let dim = chunks[0].embedding.len() as i32;
        if dim == 0 {
            return Err("Chunk #0 has empty embedding".to_string());
        }

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let schema = make_schema_v2(dim);
        let batch = make_batch_v2(schema.clone(), &page_id, &chunks, dim)?;
        let data = vec![batch];

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if tables.contains(&TABLE_V2.to_string()) {
            let table = db
                .open_table(TABLE_V2)
                .execute()
                .await
                .map_err(|e| format!("Open table error: {e}"))?;

            if let Err(e) = table.delete(&format!("page_id = '{}'", page_id)).await {
                eprintln!(
                    "[vectorstore v2] Warning: delete before upsert failed for page '{}': {}",
                    page_id, e
                );
            }

            table
                .add(data)
                .execute()
                .await
                .map_err(|e| format!("Add error: {e}"))?;
        } else {
            db.create_table(TABLE_V2, data)
                .execute()
                .await
                .map_err(|e| format!("Create table error: {e}"))?;
        }

        Ok(())
    })
    .await
}

async fn vector_replace_all_chunks_locked(
    project_path: String,
    pages: Vec<PageChunksReplaceInput>,
    temp_table_name: Option<String>,
) -> Result<(), String> {
    if pages.is_empty() {
        return Err("Replacement requires at least one page".to_string());
    }

    let mut dim: Option<i32> = None;
    let mut expected_rows = 0usize;
    let mut batches: Vec<RecordBatch> = Vec::with_capacity(pages.len());

    for page in &pages {
        validate_page_id_for_v2(&page.page_id)?;
        if page.chunks.is_empty() {
            return Err(format!("Replacement page '{}' has no chunks", page.page_id));
        }
        let page_dim = page.chunks[0].embedding.len() as i32;
        if page_dim == 0 {
            return Err(format!(
                "Replacement page '{}' has empty embedding",
                page.page_id
            ));
        }
        if let Some(existing_dim) = dim {
            if existing_dim != page_dim {
                return Err(format!(
                    "Replacement page '{}' has embedding dim {} but rebuild dim is {}",
                    page.page_id, page_dim, existing_dim
                ));
            }
        } else {
            dim = Some(page_dim);
        }
        expected_rows += page.chunks.len();
        let schema = make_schema_v2(dim.unwrap());
        batches.push(make_batch_v2(
            schema,
            &page.page_id,
            &page.chunks,
            dim.unwrap(),
        )?);
    }

    let temp_table = temp_table_name
        .unwrap_or_else(|| format!("{}_rebuild_{}", TABLE_V2, Uuid::new_v4().simple()));
    let temp_dir = table_dir(&project_path, &temp_table);

    {
        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let table = db
            .create_table(&temp_table, batches)
            .execute()
            .await
            .map_err(|e| format!("Create replacement table error: {e}"))?;

        let count = table
            .count_rows(None)
            .await
            .map_err(|e| format!("Count replacement table error: {e}"))?;
        if count != expected_rows {
            let _ = db.drop_table(&temp_table, &[]).await;
            return Err(format!(
                "Replacement table row count mismatch: expected {expected_rows}, got {count}"
            ));
        }
    }

    let final_dir = table_dir(&project_path, TABLE_V2);
    let backup_table = format!("{}_backup_{}", TABLE_V2, Uuid::new_v4().simple());
    let backup_dir = table_dir(&project_path, &backup_table);
    let mut backup_created = false;

    if final_dir.exists() {
        std::fs::rename(&final_dir, &backup_dir)
            .map_err(|e| format!("Backup existing chunks error: {e}"))?;
        backup_created = true;
    }

    if let Err(e) = std::fs::rename(&temp_dir, &final_dir) {
        if backup_created {
            if let Err(restore_error) = std::fs::rename(&backup_dir, &final_dir) {
                return Err(format_replace_restore_failed_error(
                    &final_dir,
                    &backup_dir,
                    &temp_dir,
                    &e,
                    &restore_error,
                ));
            }
        }
        cleanup_failed_replacement_temp_dir(&temp_dir);
        return Err(format_replace_no_backup_failed_error(
            &final_dir, &temp_dir, &e,
        ));
    }

    if backup_created {
        let _ = std::fs::remove_dir_all(&backup_dir);
    }

    Ok(())
}

/// Replace the entire v2 chunk table with a fully prepared rebuild.
/// The old table is left untouched until the replacement table has been
/// written and row-count checked, then the on-disk Lance table directory
/// is switched while holding the per-project vector lock.
#[tauri::command]
pub async fn vector_replace_all_chunks(
    project_path: String,
    pages: Vec<PageChunksReplaceInput>,
) -> Result<(), String> {
    run_guarded_async("vector_replace_all_chunks", async move {
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;
        vector_replace_all_chunks_locked(project_path, pages, None).await
    })
    .await
}

/// Top-K chunk search. Returns every matching chunk's metadata + score
/// (1 / (1 + distance), matching v1's convention for drop-in replacement
/// at the TS layer). TS is responsible for grouping by page_id.
#[tauri::command]
pub async fn vector_search_chunks(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
) -> Result<Vec<ChunkSearchResult>, String> {
    run_guarded_async("vector_search_chunks", async move {
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V2.to_string()) {
            return Ok(vec![]);
        }

        let table = db
            .open_table(TABLE_V2)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        let results_stream = table
            .vector_search(query_embedding)
            .map_err(|e| format!("Search error: {e}"))?
            .limit(top_k)
            .execute()
            .await
            .map_err(|e| format!("Execute search error: {e}"))?;

        use futures::TryStreamExt;
        let batches: Vec<RecordBatch> = results_stream
            .try_collect()
            .await
            .map_err(|e| format!("Collect error: {e}"))?;

        let mut out: Vec<ChunkSearchResult> = Vec::new();
        for batch in &batches {
            let chunk_ids = batch
                .column_by_name("chunk_id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or("Missing chunk_id column")?;
            let page_ids = batch
                .column_by_name("page_id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or("Missing page_id column")?;
            let chunk_indexes = batch
                .column_by_name("chunk_index")
                .and_then(|c| c.as_any().downcast_ref::<UInt32Array>())
                .ok_or("Missing chunk_index column")?;
            let chunk_texts = batch
                .column_by_name("chunk_text")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or("Missing chunk_text column")?;
            let heading_paths = batch
                .column_by_name("heading_path")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or("Missing heading_path column")?;
            let distances = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
                .ok_or("Missing _distance column")?;

            for i in 0..batch.num_rows() {
                let distance = distances.value(i);
                out.push(ChunkSearchResult {
                    chunk_id: chunk_ids.value(i).to_string(),
                    page_id: page_ids.value(i).to_string(),
                    chunk_index: chunk_indexes.value(i),
                    chunk_text: chunk_texts.value(i).to_string(),
                    heading_path: heading_paths.value(i).to_string(),
                    score: 1.0 / (1.0 + distance),
                });
            }
        }

        Ok(out)
    })
    .await
}

/// Delete every chunk belonging to a page. Used when a source document
/// is removed, or before a full re-embed of a page whose content shrank.
#[tauri::command]
pub async fn vector_delete_page(project_path: String, page_id: String) -> Result<(), String> {
    run_guarded_async("vector_delete_page", async move {
        validate_page_id_for_v2(&page_id)?;
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V2.to_string()) {
            return Ok(());
        }

        let table = db
            .open_table(TABLE_V2)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        table
            .delete(&format!("page_id = '{}'", page_id))
            .await
            .map_err(|e| format!("Delete error: {e}"))?;

        Ok(())
    })
    .await
}

/// Total chunk count in the v2 table (not pages — chunks). Useful for
/// "vector index has N chunks" status text.
#[tauri::command]
pub async fn vector_count_chunks(project_path: String) -> Result<usize, String> {
    run_guarded_async("vector_count_chunks", async move {
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V2.to_string()) {
            return Ok(0);
        }

        let table = db
            .open_table(TABLE_V2)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        let count = table
            .count_rows(None)
            .await
            .map_err(|e| format!("Count error: {e}"))?;

        Ok(count)
    })
    .await
}

/// Report whether the legacy per-page v1 table exists with any rows —
/// the TS layer uses this to show a one-time "re-index to v2" prompt in
/// Settings → Embedding after upgrading. Returns 0 when v1 is absent or
/// empty; otherwise returns the row count.
#[tauri::command]
pub async fn vector_legacy_row_count(project_path: String) -> Result<usize, String> {
    run_guarded_async("vector_legacy_row_count", async move {
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V1.to_string()) {
            return Ok(0);
        }

        let table = db
            .open_table(TABLE_V1)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        let count = table
            .count_rows(None)
            .await
            .map_err(|e| format!("Count error: {e}"))?;

        Ok(count)
    })
    .await
}

/// Drop the legacy v1 table entirely. Called from Settings → Embedding
/// after the user has re-indexed into v2 so the orphaned v1 table stops
/// taking disk space. No-op if v1 isn't present.
#[tauri::command]
pub async fn vector_drop_legacy(project_path: String) -> Result<(), String> {
    run_guarded_async("vector_drop_legacy", async move {
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V1.to_string()) {
            return Ok(());
        }

        // LanceDB 0.27's drop_table takes (name, namespace) — we keep
        // the default namespace by passing an empty slice.
        db.drop_table(TABLE_V1, &[])
            .await
            .map_err(|e| format!("Drop table error: {e}"))?;

        Ok(())
    })
    .await
}

/// Drop all v2 chunk rows for a project. Used by safe rebuild after the
/// TypeScript layer has already prepared replacement rows.
#[tauri::command]
pub async fn vector_clear_chunks(project_path: String) -> Result<(), String> {
    run_guarded_async("vector_clear_chunks", async move {
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V2.to_string()) {
            return Ok(());
        }

        db.drop_table(TABLE_V2, &[])
            .await
            .map_err(|e| format!("Clear chunks error: {e}"))?;

        Ok(())
    })
    .await
}

/// Best-effort LanceDB optimization for the v2 chunk table.
#[tauri::command]
pub async fn vector_optimize_chunks(project_path: String) -> Result<(), String> {
    run_guarded_async("vector_optimize_chunks", async move {
        let lock = project_vector_lock(&project_path).await;
        let _guard = lock.lock().await;

        let db = connect(&db_path(&project_path))
            .execute()
            .await
            .map_err(|e| format!("DB connect error: {e}"))?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("List tables error: {e}"))?;

        if !tables.contains(&TABLE_V2.to_string()) {
            return Ok(());
        }

        let table = db
            .open_table(TABLE_V2)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;
        table
            .optimize(OptimizeAction::All)
            .await
            .map_err(|e| format!("Optimize chunks error: {e}"))?;

        Ok(())
    })
    .await
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
//
// These exercise the pure data-shape and upsert/search/delete contracts
// of the v2 chunk store against a throwaway LanceDB instance per test.
// The goal is to catch schema drift and misbehaving batch construction
// early — they are NOT end-to-end tests of the embedding pipeline
// (that lives on the TS side).
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests_v2 {
    use super::*;
    use std::path::PathBuf;

    /// Unique temp project dir per test. `tokio::test` runs tests in
    /// parallel threads so wall-clock nanoseconds aren't sufficient — a
    /// process-wide atomic counter guarantees uniqueness even when two
    /// tests call this at the same tick. Not cleaned up on purpose:
    /// LanceDB's internal file handles can linger briefly after `drop`
    /// and aggressive removal introduces flaky failures on CI.
    fn tmp_project() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("llm-wiki-vtest-{}-{}", ts, id));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Deterministic toy embedding of fixed dim. Different seeds produce
    /// different vectors so nearest-neighbour ordering is stable but
    /// non-trivial.
    fn fake_embedding(seed: u32, dim: usize) -> Vec<f32> {
        (0..dim)
            .map(|i| {
                let x = ((seed.wrapping_mul(2654435761)) ^ (i as u32)) as f32;
                (x / u32::MAX as f32).sin()
            })
            .collect()
    }

    fn make_chunks(page_id: &str, n: u32, dim: usize) -> Vec<ChunkUpsertInput> {
        (0..n)
            .map(|i| ChunkUpsertInput {
                chunk_index: i,
                chunk_text: format!("{} chunk {}", page_id, i),
                heading_path: format!("## Heading {}", i),
                embedding: fake_embedding(i, dim),
            })
            .collect()
    }

    #[test]
    fn replace_restore_failure_error_includes_table_paths() {
        let replace_error =
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "replace denied");
        let restore_error = std::io::Error::new(std::io::ErrorKind::NotFound, "backup missing");

        let message = format_replace_restore_failed_error(
            Path::new("/project/.llm-wiki/lancedb/wiki_chunks_v2.lance"),
            Path::new("/project/.llm-wiki/lancedb/wiki_chunks_v2_backup_123.lance"),
            Path::new("/project/.llm-wiki/lancedb/wiki_chunks_v2_rebuild_456.lance"),
            &replace_error,
            &restore_error,
        );

        assert!(message.contains("replace denied"));
        assert!(message.contains("backup missing"));
        assert!(message.contains("Old table may still be available at backup path"));
        assert!(message.contains("/project/.llm-wiki/lancedb/wiki_chunks_v2.lance"));
        assert!(message.contains("/project/.llm-wiki/lancedb/wiki_chunks_v2_backup_123.lance"));
        assert!(message.contains("/project/.llm-wiki/lancedb/wiki_chunks_v2_rebuild_456.lance"));
    }

    #[test]
    fn replace_no_backup_failure_error_includes_table_paths() {
        let replace_error =
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "replace denied");

        let message = format_replace_no_backup_failed_error(
            Path::new("/project/.llm-wiki/lancedb/wiki_chunks_v2.lance"),
            Path::new("/project/.llm-wiki/lancedb/wiki_chunks_v2_rebuild_456.lance"),
            &replace_error,
        );

        assert!(message.contains("replace denied"));
        assert!(message.contains("final path"));
        assert!(message.contains("temp path"));
        assert!(message.contains("/project/.llm-wiki/lancedb/wiki_chunks_v2.lance"));
        assert!(message.contains("/project/.llm-wiki/lancedb/wiki_chunks_v2_rebuild_456.lance"));
    }

    #[test]
    fn cleanup_failed_replacement_temp_dir_removes_leftover_temp_table() {
        let p = tmp_project();
        let temp_dir = p.join(".llm-wiki/lancedb/wiki_chunks_v2_rebuild_test.lance");
        std::fs::create_dir_all(&temp_dir).unwrap();
        std::fs::write(temp_dir.join("marker"), "temp").unwrap();

        cleanup_failed_replacement_temp_dir(&temp_dir);

        assert!(!temp_dir.exists());
    }

    #[tokio::test]
    async fn v2_upsert_then_count() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        let chunks = make_chunks("my-page", 3, 16);
        vector_upsert_chunks(pp.clone(), "my-page".into(), chunks)
            .await
            .unwrap();

        let count = vector_count_chunks(pp.clone()).await.unwrap();
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn v2_upsert_replaces_existing_chunks_for_page() {
        // First insert 5 chunks, then re-upsert 2 — the final count
        // should be 2, not 7 (old rows deleted before insert).
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 5, 16))
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 5);

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 2, 16))
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn v2_different_pages_coexist() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();
        vector_upsert_chunks(pp.clone(), "page-b".into(), make_chunks("page-b", 4, 16))
            .await
            .unwrap();

        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 7);
    }

    #[tokio::test]
    async fn replace_all_chunks_swaps_complete_rebuild() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 3);

        vector_replace_all_chunks(
            pp.clone(),
            vec![PageChunksReplaceInput {
                page_id: "page-b".into(),
                chunks: make_chunks("page-b", 2, 16),
            }],
        )
        .await
        .unwrap();

        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);
        let results = vector_search_chunks(pp, fake_embedding(0, 16), 10)
            .await
            .unwrap();
        assert!(!results.is_empty());
        assert!(results.iter().all(|r| r.page_id == "page-b"));
    }

    #[tokio::test]
    async fn replace_all_chunks_preserves_old_table_when_temp_write_fails() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();

        let result = vector_replace_all_chunks_locked(
            pp.clone(),
            vec![PageChunksReplaceInput {
                page_id: "page-b".into(),
                chunks: make_chunks("page-b", 2, 16),
            }],
            Some(TABLE_V2.to_string()),
        )
        .await;

        assert!(result.is_err());
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 3);
        let results = vector_search_chunks(pp, fake_embedding(0, 16), 10)
            .await
            .unwrap();
        assert!(!results.is_empty());
        assert!(results.iter().all(|r| r.page_id == "page-a"));
    }

    #[tokio::test]
    async fn v2_delete_page_removes_only_its_chunks() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();
        vector_upsert_chunks(pp.clone(), "page-b".into(), make_chunks("page-b", 2, 16))
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 5);

        vector_delete_page(pp.clone(), "page-a".into())
            .await
            .unwrap();
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn v2_search_returns_chunks_with_metadata() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();

        let query = fake_embedding(1, 16);
        let results = vector_search_chunks(pp.clone(), query, 10).await.unwrap();
        assert!(!results.is_empty());
        // Every result should carry page_id, chunk_id, chunk_text, heading_path.
        for r in &results {
            assert_eq!(r.page_id, "page-a");
            assert!(r.chunk_id.starts_with("page-a#"));
            assert!(r.chunk_text.contains("chunk"));
            assert!(r.heading_path.starts_with("## Heading"));
        }
    }

    #[tokio::test]
    async fn v2_empty_upsert_is_a_noop_not_an_error() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Upserting [] should succeed and NOT wipe existing rows — this
        // is the "transient ingest failure shouldn't nuke index" contract.
        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 3, 16))
            .await
            .unwrap();
        vector_upsert_chunks(pp.clone(), "page-a".into(), vec![])
            .await
            .unwrap();

        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 3);
    }

    #[tokio::test]
    async fn v2_search_on_missing_table_returns_empty() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        let query = fake_embedding(1, 16);
        let results = vector_search_chunks(pp, query, 10).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn v2_count_on_missing_table_returns_zero() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        assert_eq!(vector_count_chunks(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn v2_delete_page_is_idempotent() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Delete on missing table: ok.
        vector_delete_page(pp.clone(), "never-existed".into())
            .await
            .unwrap();

        // Insert + delete + delete again: ok.
        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 2, 16))
            .await
            .unwrap();
        vector_delete_page(pp.clone(), "page-a".into())
            .await
            .unwrap();
        vector_delete_page(pp.clone(), "page-a".into())
            .await
            .unwrap();

        assert_eq!(vector_count_chunks(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn v2_rejects_mismatched_embedding_dimensions() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // First chunk sets dim=16; second chunk has dim=8 → should error.
        let bad = vec![
            ChunkUpsertInput {
                chunk_index: 0,
                chunk_text: "ok".into(),
                heading_path: "".into(),
                embedding: fake_embedding(0, 16),
            },
            ChunkUpsertInput {
                chunk_index: 1,
                chunk_text: "bad".into(),
                heading_path: "".into(),
                embedding: fake_embedding(1, 8),
            },
        ];
        let result = vector_upsert_chunks(pp, "page-a".into(), bad).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_lowercase().contains("dim"));
    }

    #[tokio::test]
    async fn v2_rejects_invalid_page_id() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Quote would be a SQL-injection footgun for the delete filter.
        let result = vector_upsert_chunks(pp, "bad'; DROP".into(), make_chunks("x", 1, 16)).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn v2_accepts_unicode_and_long_encoded_page_id() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();
        let page_id = format!("wp_{}", "默会知识_".repeat(80));

        vector_upsert_chunks(pp.clone(), page_id.clone(), make_chunks("unicode", 1, 16))
            .await
            .unwrap();

        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 1);
        vector_delete_page(pp.clone(), page_id).await.unwrap();
        assert_eq!(vector_count_chunks(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn clear_chunks_drops_v2_without_touching_legacy() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert(pp.clone(), "old-page".into(), fake_embedding(0, 16))
            .await
            .unwrap();
        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 2, 16))
            .await
            .unwrap();

        vector_clear_chunks(pp.clone()).await.unwrap();

        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 0);
        assert_eq!(vector_legacy_row_count(pp).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn optimize_chunks_is_noop_when_missing_and_ok_when_present() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_optimize_chunks(pp.clone()).await.unwrap();
        vector_upsert_chunks(pp.clone(), "page-a".into(), make_chunks("page-a", 2, 16))
            .await
            .unwrap();
        vector_optimize_chunks(pp).await.unwrap();
    }

    #[tokio::test]
    async fn legacy_row_count_returns_zero_when_absent() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // v1 table doesn't exist in a fresh temp project.
        assert_eq!(vector_legacy_row_count(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn legacy_row_count_sees_v1_rows() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Populate v1 via the legacy vector_upsert.
        vector_upsert(pp.clone(), "old-page".into(), fake_embedding(0, 16))
            .await
            .unwrap();

        let count = vector_legacy_row_count(pp.clone()).await.unwrap();
        assert_eq!(count, 1);

        // v2 count is untouched.
        assert_eq!(vector_count_chunks(pp).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn drop_legacy_removes_v1_but_leaves_v2() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        vector_upsert(pp.clone(), "old-page".into(), fake_embedding(0, 16))
            .await
            .unwrap();
        vector_upsert_chunks(
            pp.clone(),
            "new-page".into(),
            make_chunks("new-page", 2, 16),
        )
        .await
        .unwrap();

        assert_eq!(vector_legacy_row_count(pp.clone()).await.unwrap(), 1);
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);

        vector_drop_legacy(pp.clone()).await.unwrap();

        assert_eq!(vector_legacy_row_count(pp.clone()).await.unwrap(), 0);
        assert_eq!(vector_count_chunks(pp.clone()).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn drop_legacy_is_noop_when_v1_missing() {
        let p = tmp_project();
        let pp = p.to_string_lossy().to_string();

        // Should just return Ok(()), not error.
        vector_drop_legacy(pp).await.unwrap();
    }
}

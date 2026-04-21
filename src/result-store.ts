import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SearchResult, StoredResult, StoredParagraph, FtsMatch } from './types.js';
import { chunkIntoParagraphs } from './paragraph-chunker.js';

export class ResultStore {
  private db: Database.Database | null = null;
  private dbPath: string | null = null;

  initialize(): void {
    if (this.db) return;

    this.dbPath = path.join(os.tmpdir(), `web-search-mcp-${process.pid}.sqlite`);
    this.db = new Database(this.dbPath);

    // Performance pragmas for an ephemeral DB
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000'); // 64MB query cache
    this.db.pragma('temp_store = MEMORY');  // Keep temp tables in RAM
    this.db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
    this.db.pragma('locking_mode = EXCLUSIVE'); // Single-process, skip lock overhead
    this.db.pragma('foreign_keys = ON'); // Enforce ON DELETE CASCADE on paragraphs.result_id

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS results (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT NOT NULL,
        url         TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        word_count  INTEGER NOT NULL DEFAULT 0,
        fetch_status TEXT NOT NULL DEFAULT 'success',
        timestamp   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paragraphs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        result_id       INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
        paragraph_index INTEGER NOT NULL,
        content         TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS paragraphs_fts
        USING fts5(content, content='paragraphs', content_rowid='id', tokenize='porter');

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS paragraphs_ai AFTER INSERT ON paragraphs BEGIN
        INSERT INTO paragraphs_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS paragraphs_ad AFTER DELETE ON paragraphs BEGIN
        INSERT INTO paragraphs_fts(paragraphs_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;

      -- Performance indexes for faster lookups
      CREATE INDEX IF NOT EXISTS idx_paragraphs_result_id ON paragraphs(result_id);
      CREATE INDEX IF NOT EXISTS idx_paragraphs_result_idx ON paragraphs(result_id, paragraph_index);
      CREATE INDEX IF NOT EXISTS idx_results_timestamp ON results(timestamp);
    `);

    console.log(`[ResultStore] Initialized at ${this.dbPath}`);
  }

  /** Wipe all rows — called before each new search / page-fetch. */
  clear(): void {
    if (!this.db) return;
    this.db.exec(`
      DELETE FROM paragraphs;
      DELETE FROM results;
      DELETE FROM paragraphs_fts;
    `);
  }

  /** Store a batch of SearchResults, chunking their fullContent into paragraphs.
   *  Returns the IDs of newly inserted results. */
  storeResults(results: SearchResult[]): number[] {
    if (!this.db) return [];

    const insertResult = this.db.prepare(`
      INSERT INTO results (title, url, description, word_count, fetch_status, timestamp)
      VALUES (@title, @url, @description, @wordCount, @fetchStatus, @timestamp)
    `);

    const insertParagraph = this.db.prepare(`
      INSERT INTO paragraphs (result_id, paragraph_index, content)
      VALUES (@resultId, @paragraphIndex, @content)
    `);

    const newIds: number[] = [];

    const tx = this.db.transaction((items: SearchResult[]) => {
      // Disable FTS trigger during bulk insert, rebuild once after
      this.db!.exec('DROP TRIGGER IF EXISTS paragraphs_ai');

      for (const r of items) {
        const info = insertResult.run({
          title: r.title,
          url: r.url,
          description: r.description,
          wordCount: r.wordCount,
          fetchStatus: r.fetchStatus,
          timestamp: r.timestamp,
        });
        const resultId = Number(info.lastInsertRowid);
        newIds.push(resultId);

        const text = r.fullContent || r.contentPreview || '';
        if (text.trim()) {
          const chunks = chunkIntoParagraphs(text);
          for (let i = 0; i < chunks.length; i++) {
            insertParagraph.run({
              resultId,
              paragraphIndex: i,
              content: chunks[i],
            });
          }
        }
      }

      // Bulk-populate FTS only for paragraphs we just inserted (filter by newIds
      // to avoid re-indexing previously-stored paragraphs, which would create
      // duplicate FTS entries and eventually corrupt search results).
      if (newIds.length > 0) {
        const placeholders = newIds.map(() => '?').join(',');
        this.db!.prepare(`
          INSERT INTO paragraphs_fts(rowid, content)
          SELECT id, content FROM paragraphs
          WHERE result_id IN (${placeholders})
        `).run(...newIds);
      }

      // Restore the trigger for future single-row inserts
      this.db!.exec(`
        CREATE TRIGGER IF NOT EXISTS paragraphs_ai AFTER INSERT ON paragraphs BEGIN
          INSERT INTO paragraphs_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
    });

    tx(results);
    console.log(`[ResultStore] Stored ${results.length} results (IDs: ${newIds.join(', ')})`);
    return newIds;
  }

  /** Keep at most `max` results, deleting the oldest by ID. */
  trimOldest(max: number): void {
    if (!this.db) return;
    const count = (this.db.prepare('SELECT COUNT(*) AS cnt FROM results').get() as { cnt: number }).cnt;
    if (count <= max) return;
    const excess = count - max;

    // Delete oldest results (lowest IDs) — cascading triggers handle FTS cleanup
    // Using a single efficient query to delete the excess number of oldest items
    this.db.exec(`
      DELETE FROM results 
      WHERE id IN (SELECT id FROM results ORDER BY id ASC LIMIT ${excess})
    `);
    console.log(`[ResultStore] Trimmed ${excess} oldest results (kept ${max})`);
  }

  /** Get stored results by their IDs (for showing just-inserted results). */
  getResultsByIds(ids: number[]): StoredResult[] {
    if (!this.db || ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT
        r.id,
        r.title,
        r.url,
        r.description,
        r.word_count   AS wordCount,
        r.fetch_status AS fetchStatus,
        r.timestamp,
        COUNT(p.id)    AS paragraphCount
      FROM results r
      LEFT JOIN paragraphs p ON p.result_id = r.id
      WHERE r.id IN (${placeholders})
      GROUP BY r.id
      ORDER BY r.id
    `).all(...ids) as StoredResult[];
  }

  /** List all stored results with paragraph counts. */
  listResults(): StoredResult[] {
    if (!this.db) return [];

    return this.db.prepare(`
      SELECT
        r.id,
        r.title,
        r.url,
        r.description,
        r.word_count   AS wordCount,
        r.fetch_status AS fetchStatus,
        r.timestamp,
        COUNT(p.id)    AS paragraphCount
      FROM results r
      LEFT JOIN paragraphs p ON p.result_id = r.id
      GROUP BY r.id
      ORDER BY r.id
    `).all() as StoredResult[];
  }

  /** Get paragraphs for a result, optionally paginated. */
  getResultParagraphs(
    resultId: number,
    startParagraph?: number,
    endParagraph?: number,
  ): StoredParagraph[] {
    if (!this.db) return [];

    let sql = `
      SELECT id, result_id AS resultId, paragraph_index AS paragraphIndex, content
      FROM paragraphs
      WHERE result_id = ?
    `;
    const params: unknown[] = [resultId];

    if (startParagraph !== undefined) {
      sql += ' AND paragraph_index >= ?';
      params.push(startParagraph);
    }
    if (endParagraph !== undefined) {
      sql += ' AND paragraph_index <= ?';
      params.push(endParagraph);
    }
    sql += ' ORDER BY paragraph_index';

    return this.db.prepare(sql).all(...params) as StoredParagraph[];
  }

  /** Full-text search across all stored paragraphs. */
  search(query: string, limit = 20): FtsMatch[] {
    if (!this.db) return [];

    // FTS5 has no backslash-escape for operators. Strip everything except word chars
    // and whitespace to guarantee a valid query; terms become implicit-AND.
    const sanitized = query.replace(/[^\w\s]/g, ' ').trim();
    if (!sanitized) return [];

    return this.db.prepare(`
      SELECT
        p.result_id      AS resultId,
        p.paragraph_index AS paragraphIndex,
        snippet(paragraphs_fts, 0, '>>>', '<<<', '...', 40) AS snippet,
        p.content,
        r.title          AS resultTitle,
        r.url            AS resultUrl
      FROM paragraphs_fts fts
      JOIN paragraphs p ON p.id = fts.rowid
      JOIN results r    ON r.id = p.result_id
      WHERE paragraphs_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(sanitized, limit) as FtsMatch[];
  }

  /** Cleanup: close DB and remove temp file. */
  close(): void {
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
    if (this.dbPath) {
      try { fs.unlinkSync(this.dbPath); } catch { /* ignore */ }
      console.log(`[ResultStore] Cleaned up ${this.dbPath}`);
      this.dbPath = null;
    }
  }
}

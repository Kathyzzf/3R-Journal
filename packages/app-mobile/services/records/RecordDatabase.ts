import Logger from '@joplin/utils/Logger';
import { reg } from '@joplin/lib/registry';

const logger = Logger.create('RecordDatabase');

export interface RecordEntry {
	id: string;
	note_id: string;
	entry_type: string;
	source_url: string;
	tags: string;
	created_time: number;
	updated_time: number;
	is_deleted: number;
}

export type RecordEntryType = 'text' | 'voice' | 'drawing' | 'image' | 'file' | 'audio' | 'video' | 'weblink' | 'youtube';

export interface RecordReflection {
	id: string;
	record_id: string;
	note_id: string;
	source_hash: string;
	payload: string;
	markdown_path: string;
	created_time: number;
	updated_time: number;
}

export interface RecordFlashcard {
	id: string;
	record_id: string;
	reflection_id: string;
	front: string;
	back: string;
	source_key: string;
	position_x: number;
	position_y: number;
	group_key: string;
	due_time: number;
	interval_days: number;
	ease_factor: number;
	review_count: number;
	created_time: number;
	updated_time: number;
	is_deleted: number;
}

export interface RecordShareEvent {
	id: string;
	record_id: string;
	target: string;
	content_type: string;
	created_time: number;
}

export type RecordProcessingQueueStatus = 'pending' | 'running' | 'done' | 'error';

export interface RecordProcessingQueueItem {
	id: string;
	record_id: string;
	task_type: 'reflect_refine';
	priority: number;
	status: RecordProcessingQueueStatus;
	scheduled_time: number;
	last_error: string;
	created_time: number;
	updated_time: number;
}

export default class RecordDatabase {
	private static initialized_ = false;

	private static db() {
		return reg.db();
	}

	public static async initialize() {
		if (this.initialized_) return;

		const db = this.db();
		if (!db) {
			logger.warn('Database not available yet');
			return;
		}

		try {
			await db.exec(`
				CREATE TABLE IF NOT EXISTS record_entries (
					id TEXT PRIMARY KEY,
					note_id TEXT NOT NULL,
					entry_type TEXT NOT NULL DEFAULT 'text',
					source_url TEXT NOT NULL DEFAULT '',
					tags TEXT NOT NULL DEFAULT '[]',
					created_time INTEGER NOT NULL,
					updated_time INTEGER NOT NULL,
					is_deleted INTEGER NOT NULL DEFAULT 0
				)
			`);
			await db.exec(`
				CREATE TABLE IF NOT EXISTS record_reflections (
					id TEXT PRIMARY KEY,
					record_id TEXT NOT NULL,
					note_id TEXT NOT NULL,
					source_hash TEXT NOT NULL,
					payload TEXT NOT NULL,
					markdown_path TEXT NOT NULL DEFAULT '',
					created_time INTEGER NOT NULL,
					updated_time INTEGER NOT NULL
				)
			`);
			await db.exec(`
				CREATE TABLE IF NOT EXISTS record_flashcards (
					id TEXT PRIMARY KEY,
					record_id TEXT NOT NULL,
					reflection_id TEXT NOT NULL,
					front TEXT NOT NULL,
					back TEXT NOT NULL,
					source_key TEXT NOT NULL DEFAULT '',
					position_x INTEGER NOT NULL DEFAULT 0,
					position_y INTEGER NOT NULL DEFAULT 0,
					group_key TEXT NOT NULL DEFAULT '',
					due_time INTEGER NOT NULL,
					interval_days INTEGER NOT NULL DEFAULT 1,
					ease_factor REAL NOT NULL DEFAULT 2.5,
					review_count INTEGER NOT NULL DEFAULT 0,
					created_time INTEGER NOT NULL,
					updated_time INTEGER NOT NULL,
					is_deleted INTEGER NOT NULL DEFAULT 0
				)
			`);
			await db.exec(`
				CREATE TABLE IF NOT EXISTS record_share_events (
					id TEXT PRIMARY KEY,
					record_id TEXT NOT NULL,
					target TEXT NOT NULL,
					content_type TEXT NOT NULL,
					created_time INTEGER NOT NULL
				)
			`);
			await db.exec(`
				CREATE TABLE IF NOT EXISTS record_processing_queue (
					id TEXT PRIMARY KEY,
					record_id TEXT NOT NULL,
					task_type TEXT NOT NULL DEFAULT 'reflect_refine',
					priority INTEGER NOT NULL DEFAULT 0,
					status TEXT NOT NULL DEFAULT 'pending',
					scheduled_time INTEGER NOT NULL,
					last_error TEXT NOT NULL DEFAULT '',
					created_time INTEGER NOT NULL,
					updated_time INTEGER NOT NULL
				)
			`);

			// Check if indexes exist before creating
			const rows = await db.selectAll("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_record_%'");
			const existingIndexes = rows.map((r: { name: string }) => r.name);

			if (!existingIndexes.includes('idx_record_entries_note_id')) {
				await db.exec('CREATE INDEX idx_record_entries_note_id ON record_entries(note_id)');
			}
			if (!existingIndexes.includes('idx_record_entries_created_time')) {
				await db.exec('CREATE INDEX idx_record_entries_created_time ON record_entries(created_time)');
			}
			if (!existingIndexes.includes('idx_record_entries_entry_type')) {
				await db.exec('CREATE INDEX idx_record_entries_entry_type ON record_entries(entry_type)');
			}
			if (!existingIndexes.includes('idx_record_reflections_record_id')) {
				await db.exec('CREATE INDEX idx_record_reflections_record_id ON record_reflections(record_id)');
			}
			if (!existingIndexes.includes('idx_record_flashcards_record_id')) {
				await db.exec('CREATE INDEX idx_record_flashcards_record_id ON record_flashcards(record_id)');
			}
			if (!existingIndexes.includes('idx_record_flashcards_due_time')) {
				await db.exec('CREATE INDEX idx_record_flashcards_due_time ON record_flashcards(due_time)');
			}
			if (!existingIndexes.includes('idx_record_share_events_record_id')) {
				await db.exec('CREATE INDEX idx_record_share_events_record_id ON record_share_events(record_id)');
			}
			if (!existingIndexes.includes('idx_record_processing_queue_pending')) {
				await db.exec('CREATE INDEX idx_record_processing_queue_pending ON record_processing_queue(status, priority, scheduled_time, created_time)');
			}
			if (!existingIndexes.includes('idx_record_processing_queue_record_id')) {
				await db.exec('CREATE INDEX idx_record_processing_queue_record_id ON record_processing_queue(record_id)');
			}

			this.initialized_ = true;
			logger.info('RecordDatabase initialized');
		} catch (error) {
			logger.error('Failed to initialize record_entries table:', error);
			throw error;
		}
	}

	public static async insert(entry: RecordEntry): Promise<void> {
		await this.initialize();
		const db = this.db();

		await db.exec(
			`INSERT INTO record_entries (id, note_id, entry_type, source_url, tags, created_time, updated_time, is_deleted)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[entry.id, entry.note_id, entry.entry_type, entry.source_url, entry.tags, entry.created_time, entry.updated_time, entry.is_deleted],
		);
	}

	public static async update(id: string, changes: Partial<RecordEntry>): Promise<void> {
		await this.initialize();
		const db = this.db();

		const fields: string[] = [];
		const values: (string | number)[] = [];

		for (const [key, value] of Object.entries(changes)) {
			if (key === 'id') continue;
			fields.push(`${key} = ?`);
			values.push(value as string | number);
		}

		if (!fields.length) return;

		values.push(id);
		await db.exec(`UPDATE record_entries SET ${fields.join(', ')} WHERE id = ?`, values);
	}

	public static async loadById(id: string): Promise<RecordEntry | null> {
		await this.initialize();
		const db = this.db();
		return await db.selectOne('SELECT * FROM record_entries WHERE id = ? AND is_deleted = 0', [id]);
	}

	public static async loadByNoteId(noteId: string): Promise<RecordEntry | null> {
		await this.initialize();
		const db = this.db();
		return await db.selectOne('SELECT * FROM record_entries WHERE note_id = ? AND is_deleted = 0', [noteId]);
	}

	public static async all(options: { entryType?: string; limit?: number; offset?: number } = {}): Promise<RecordEntry[]> {
		await this.initialize();
		const db = this.db();

		const conditions = ['is_deleted = 0'];
		const params: (string | number)[] = [];

		if (options.entryType) {
			conditions.push('entry_type = ?');
			params.push(options.entryType);
		}

		let sql = `SELECT * FROM record_entries WHERE ${conditions.join(' AND ')} ORDER BY created_time DESC`;

		if (options.limit) {
			sql += ' LIMIT ?';
			params.push(options.limit);
		}

		if (options.offset) {
			sql += ' OFFSET ?';
			params.push(options.offset);
		}

		return await db.selectAll(sql, params);
	}

	public static async softDelete(id: string): Promise<void> {
		await this.update(id, { is_deleted: 1, updated_time: Date.now() });
	}

	public static async noteIds(): Promise<string[]> {
		await this.initialize();
		const db = this.db();
		const rows = await db.selectAll('SELECT note_id FROM record_entries WHERE is_deleted = 0');
		return rows.map((r: { note_id: string }) => r.note_id);
	}

	public static async count(): Promise<number> {
		await this.initialize();
		const db = this.db();
		const row = await db.selectOne('SELECT count(*) as total FROM record_entries WHERE is_deleted = 0');
		return row?.total ?? 0;
	}

	public static async upsertReflection(reflection: RecordReflection): Promise<void> {
		await this.initialize();
		const db = this.db();
		const existing = await db.selectOne('SELECT id FROM record_reflections WHERE record_id = ? ORDER BY updated_time DESC LIMIT 1', [reflection.record_id]);
		if (existing?.id) {
			await db.exec(
				`UPDATE record_reflections SET note_id = ?, source_hash = ?, payload = ?, markdown_path = ?, updated_time = ? WHERE id = ?`,
				[reflection.note_id, reflection.source_hash, reflection.payload, reflection.markdown_path, reflection.updated_time, existing.id],
			);
		} else {
			await db.exec(
				`INSERT INTO record_reflections (id, record_id, note_id, source_hash, payload, markdown_path, created_time, updated_time)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[reflection.id, reflection.record_id, reflection.note_id, reflection.source_hash, reflection.payload, reflection.markdown_path, reflection.created_time, reflection.updated_time],
			);
		}
	}

	public static async latestReflection(recordId: string): Promise<RecordReflection | null> {
		await this.initialize();
		const db = this.db();
		return await db.selectOne('SELECT * FROM record_reflections WHERE record_id = ? ORDER BY updated_time DESC LIMIT 1', [recordId]);
	}

	public static async allReflections(): Promise<RecordReflection[]> {
		await this.initialize();
		const db = this.db();
		return await db.selectAll('SELECT * FROM record_reflections ORDER BY updated_time DESC');
	}

	public static async replaceFlashcards(recordId: string, cards: RecordFlashcard[]): Promise<void> {
		await this.initialize();
		const db = this.db();
		const now = Date.now();
		await db.exec('UPDATE record_flashcards SET is_deleted = 1, updated_time = ? WHERE record_id = ?', [now, recordId]);
		for (const card of cards) {
			await db.exec(
				`INSERT INTO record_flashcards (id, record_id, reflection_id, front, back, source_key, position_x, position_y, group_key, due_time, interval_days, ease_factor, review_count, created_time, updated_time, is_deleted)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[card.id, card.record_id, card.reflection_id, card.front, card.back, card.source_key, card.position_x, card.position_y, card.group_key, card.due_time, card.interval_days, card.ease_factor, card.review_count, card.created_time, card.updated_time, card.is_deleted],
			);
		}
	}

	public static async flashcards(recordId?: string): Promise<RecordFlashcard[]> {
		await this.initialize();
		const db = this.db();
		if (recordId) {
			return await db.selectAll('SELECT * FROM record_flashcards WHERE record_id = ? AND is_deleted = 0 ORDER BY created_time ASC', [recordId]);
		}
		return await db.selectAll('SELECT * FROM record_flashcards WHERE is_deleted = 0 ORDER BY due_time ASC');
	}

	public static async dueFlashcards(now = Date.now()): Promise<RecordFlashcard[]> {
		await this.initialize();
		const db = this.db();
		return await db.selectAll('SELECT * FROM record_flashcards WHERE is_deleted = 0 AND due_time <= ? ORDER BY due_time ASC', [now]);
	}

	public static async updateFlashcard(id: string, changes: Partial<RecordFlashcard>): Promise<void> {
		await this.initialize();
		const db = this.db();
		const fields: string[] = [];
		const values: (string | number)[] = [];
		for (const [key, value] of Object.entries(changes)) {
			if (key === 'id') continue;
			fields.push(`${key} = ?`);
			values.push(value as string | number);
		}
		if (!fields.length) return;
		values.push(id);
		await db.exec(`UPDATE record_flashcards SET ${fields.join(', ')} WHERE id = ?`, values);
	}

	public static async insertShareEvent(event: RecordShareEvent): Promise<void> {
		await this.initialize();
		const db = this.db();
		await db.exec(
			`INSERT INTO record_share_events (id, record_id, target, content_type, created_time)
			VALUES (?, ?, ?, ?, ?)`,
			[event.id, event.record_id, event.target, event.content_type, event.created_time],
		);
	}

	public static async shareCount(): Promise<number> {
		await this.initialize();
		const db = this.db();
		const row = await db.selectOne('SELECT count(*) as total FROM record_share_events');
		return row?.total ?? 0;
	}

	public static async enqueueReflectRefine(recordId: string, priority = 0, scheduledTime = Date.now()): Promise<void> {
		await this.initialize();
		const db = this.db();
		const id = `reflect_refine:${recordId}`;
		const now = Date.now();
		const existing = await db.selectOne('SELECT id, priority, created_time FROM record_processing_queue WHERE id = ?', [id]);
		if (existing?.id) {
			await db.exec(
				`UPDATE record_processing_queue SET priority = ?, status = 'pending', scheduled_time = ?, last_error = '', updated_time = ? WHERE id = ?`,
				[Math.max(priority, existing.priority ?? 0), scheduledTime, now, id],
			);
			return;
		}

		await db.exec(
			`INSERT INTO record_processing_queue (id, record_id, task_type, priority, status, scheduled_time, last_error, created_time, updated_time)
			VALUES (?, ?, 'reflect_refine', ?, 'pending', ?, '', ?, ?)`,
			[id, recordId, priority, scheduledTime, now, now],
		);
	}

	public static async pendingProcessingQueue(limit: number, now = Date.now()): Promise<RecordProcessingQueueItem[]> {
		await this.initialize();
		const db = this.db();
		return await db.selectAll(
			`SELECT * FROM record_processing_queue
			WHERE status = 'pending' AND scheduled_time <= ?
			ORDER BY priority DESC, scheduled_time ASC, created_time ASC
			LIMIT ?`,
			[now, limit],
		);
	}

	public static async updateProcessingQueueStatus(recordId: string, status: RecordProcessingQueueStatus, lastError = ''): Promise<void> {
		await this.initialize();
		const db = this.db();
		await db.exec(
			`UPDATE record_processing_queue SET status = ?, last_error = ?, updated_time = ? WHERE id = ?`,
			[status, lastError, Date.now(), `reflect_refine:${recordId}`],
		);
	}

	public static async countSince(tableName: 'record_entries' | 'record_reflections' | 'record_flashcards' | 'record_share_events', since: number): Promise<number> {
		await this.initialize();
		const db = this.db();
		const deletedFilter = tableName === 'record_entries' || tableName === 'record_flashcards' ? ' AND is_deleted = 0' : '';
		const row = await db.selectOne(`SELECT count(*) as total FROM ${tableName} WHERE created_time >= ?${deletedFilter}`, [since]);
		return row?.total ?? 0;
	}
}

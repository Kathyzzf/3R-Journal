import Note from '@joplin/lib/models/Note';
import Folder from '@joplin/lib/models/Folder';
import Tag from '@joplin/lib/models/Tag';
import Resource from '@joplin/lib/models/Resource';
import uuid from '@joplin/lib/uuid';
import Logger from '@joplin/utils/Logger';
import RecordDatabase, { RecordEntry, RecordEntryType } from './RecordDatabase';
import { NoteEntity, ResourceEntity } from '@joplin/lib/services/database/types';
import shim from '@joplin/lib/shim';
import { Platform } from 'react-native';

const logger = Logger.create('RecordService');

const RECORDS_FOLDER_TITLE = '3R Records';
const emptySectionMessage = '_等待生成。_';
const journalBackground = '3R Journal is a creative journaling space for illustration, writing, and design. It helps students express feelings, reflect on experience, and share clearer stories with families and the community.';

const make3RBody = (recordBody: string) => {
	return [
		'# 3R Journal',
		journalBackground,
		'',
		'# Record',
		recordBody.trim() || emptySectionMessage,
		'',
		'# Reflect',
		emptySectionMessage,
		'',
		'# Refine',
		emptySectionMessage,
	].join('\n');
};

const has3RSection = (body: string, section: 'Record' | 'Reflect' | 'Refine') => {
	return new RegExp(`(^|\\n)# ${section}(\\n|$)`).test(body);
};

const hasAny3RSection = (body: string) => {
	return has3RSection(body, 'Record') || has3RSection(body, 'Reflect') || has3RSection(body, 'Refine');
};

const ensure3RBody = (body: string) => {
	let nextBody = body || '';
	if (!has3RSection(nextBody, 'Record')) return make3RBody(nextBody);
	if (!has3RSection(nextBody, 'Reflect')) nextBody = `${nextBody.trim()}\n\n# Reflect\n${emptySectionMessage}`;
	if (!has3RSection(nextBody, 'Refine')) nextBody = `${nextBody.trim()}\n\n# Refine\n${emptySectionMessage}`;
	return nextBody;
};

export interface CreateRecordOptions {
	text: string;
	title?: string;
	tags?: string[];
	entryType?: RecordEntryType;
	sourceUrl?: string;
	attachments?: RecordAttachment[];
}

export interface RecordAttachment {
	uri: string;
	fileName?: string;
	type?: string;
}

export interface RecordWithNote {
	record: RecordEntry;
	note: NoteEntity;
	tags: string[];
}

export default class RecordService {
	private static recordsFolderId_: string | null = null;

	// Get or create the dedicated Records notebook
	public static async getRecordsFolderId(): Promise<string> {
		if (this.recordsFolderId_) {
			// Verify it still exists
			const folder = await Folder.load(this.recordsFolderId_);
			if (folder && !folder.deleted_time) return this.recordsFolderId_;
			this.recordsFolderId_ = null;
		}

		// Search for existing folder
		const folders = await Folder.all({ includeDeleted: false });
		const existing = folders.find(f => f.title === RECORDS_FOLDER_TITLE);
		if (existing) {
			this.recordsFolderId_ = existing.id;
			return existing.id;
		}

		// Create the folder
		const newFolder = await Folder.save({ title: RECORDS_FOLDER_TITLE });
		this.recordsFolderId_ = newFolder.id;
		logger.info(`Created Records folder: ${newFolder.id}`);
		return newFolder.id;
	}

	public static async createRecord(options: CreateRecordOptions): Promise<RecordWithNote> {
		await RecordDatabase.initialize();

		const folderId = await this.getRecordsFolderId();
		const now = Date.now();
		const entryType = options.entryType || 'text';
		const tags = options.tags || [];

		// Determine title
		let title = options.title || '';
		if (!title && options.text) {
			// Use first line or first 50 chars as title
			const firstLine = options.text.split('\n')[0];
			title = firstLine.length > 50 ? `${firstLine.substring(0, 50)}...` : firstLine;
		}
		if (!title) {
			const typeLabels: Record<string, string> = {
				text: '文字记录',
				voice: '语音记录',
				drawing: '手绘记录',
				image: '图片记录',
				file: '文件记录',
				audio: '音频记录',
				video: '视频记录',
				weblink: '网页链接',
				youtube: 'YouTube',
			};
			title = typeLabels[entryType] || '新记录';
		}

		let body = options.text || '';
		for (const attachment of options.attachments || []) {
			const resource = await this.createAttachmentResource(attachment);
			const resourceTag = Resource.markupTag(resource);
			body = body ? `${body}\n\n${resourceTag}` : resourceTag;
		}

		const note = await Note.save({
			title,
			body: make3RBody(body),
			parent_id: folderId,
		});

		// Create record_entries row
		const recordId = uuid.create();
		const entry: RecordEntry = {
			id: recordId,
			note_id: note.id,
			entry_type: entryType,
			source_url: options.sourceUrl || '',
			tags: JSON.stringify(tags),
			created_time: now,
			updated_time: now,
			is_deleted: 0,
		};
		await RecordDatabase.insert(entry);
		await RecordDatabase.enqueueReflectRefine(recordId, 0, now);

		// Apply tags
		for (const tagTitle of tags) {
			await Tag.addNoteTagByTitle(note.id, tagTitle);
		}

		logger.info(`Created record: ${recordId} (note: ${note.id}, type: ${entryType})`);

		return { record: entry, note, tags };
	}

	private static async createAttachmentResource(attachment: RecordAttachment) {
		let filePath = attachment.uri;
		if (Platform.OS === 'ios') {
			filePath = decodeURIComponent(filePath).replace(/^file:\/\//, '');
		}

		const props: Record<string, string> = {};
		if (attachment.type) props.mime = attachment.type;
		if (attachment.fileName) props.title = attachment.fileName;

		return await shim.createResourceFromPath(filePath, props);
	}

	private static async ensureNoteHas3RSections(note: NoteEntity): Promise<NoteEntity> {
		const body = ensure3RBody(note.body || '');
		if (body === (note.body || '')) return note;
		await Note.save({ id: note.id, body } as NoteEntity);
		return {
			...note,
			body,
		};
	}

	public static async getOrCreateRecordByNote(note: NoteEntity): Promise<RecordWithNote | null> {
		if (!note?.id) return null;
		const existing = await this.getRecordByNoteId(note.id);
		if (existing) return existing;
		if (!hasAny3RSection(note.body || '')) return null;

		await RecordDatabase.initialize();
		const normalizedNote = await this.ensureNoteHas3RSections(note);
		const noteTags = await Tag.tagsByNoteId(note.id);
		const tags = noteTags.map(tag => tag.title).filter(Boolean);
		const now = Date.now();
		const entry: RecordEntry = {
			id: uuid.create(),
			note_id: note.id,
			entry_type: 'text',
			source_url: '',
			tags: JSON.stringify(tags),
			created_time: note.user_created_time || now,
			updated_time: note.user_updated_time || now,
			is_deleted: 0,
		};
		await RecordDatabase.insert(entry);
		await RecordDatabase.enqueueReflectRefine(entry.id, 0, entry.created_time);
		return { record: entry, note: normalizedNote, tags };
	}

	public static async linkedResources(recordId: string): Promise<ResourceEntity[]> {
		const record = await RecordDatabase.loadById(recordId);
		if (!record) return [];
		const note = await Note.load(record.note_id);
		if (!note) return [];
		const resourceIds = await Note.linkedResourceIds(note.body || '');
		const resources: ResourceEntity[] = [];
		for (const resourceId of resourceIds) {
			const resource = await Resource.load(resourceId);
			if (resource) resources.push(resource);
		}
		return resources;
	}

	public static async linkedVideoResources(recordId: string): Promise<ResourceEntity[]> {
		const resources = await this.linkedResources(recordId);
		return resources.filter(resource => (resource.mime || '').startsWith('video/'));
	}

	public static async updateRecord(recordId: string, updates: { text?: string; title?: string; tags?: string[] }): Promise<void> {
		const record = await RecordDatabase.loadById(recordId);
		if (!record) throw new Error(`Record not found: ${recordId}`);

		const now = Date.now();

		// Update the note
		if (updates.text !== undefined || updates.title !== undefined) {
			const noteUpdates: Partial<NoteEntity> = {};
			if (updates.text !== undefined) noteUpdates.body = ensure3RBody(updates.text);
			if (updates.title !== undefined) noteUpdates.title = updates.title;
			noteUpdates.id = record.note_id;
			await Note.save(noteUpdates as NoteEntity);
		}

		// Update tags
		if (updates.tags !== undefined) {
			await Tag.setNoteTagsByTitles(record.note_id, updates.tags);
			await RecordDatabase.update(recordId, { tags: JSON.stringify(updates.tags), updated_time: now });
		} else {
			await RecordDatabase.update(recordId, { updated_time: now });
		}
		if (updates.text !== undefined || updates.title !== undefined || updates.tags !== undefined) {
			await RecordDatabase.enqueueReflectRefine(recordId, 0, now);
		}
	}

	public static async deleteRecord(recordId: string): Promise<void> {
		await RecordDatabase.softDelete(recordId);
	}

	public static async getRecord(recordId: string): Promise<RecordWithNote | null> {
		const record = await RecordDatabase.loadById(recordId);
		if (!record) return null;

		let note = await Note.load(record.note_id);
		if (!note) return null;
		note = await this.ensureNoteHas3RSections(note);

		let tags: string[] = [];
		try {
			tags = JSON.parse(record.tags);
		} catch {
			tags = [];
		}

		return { record, note, tags };
	}

	public static async getRecordByNoteId(noteId: string): Promise<RecordWithNote | null> {
		const record = await RecordDatabase.loadByNoteId(noteId);
		if (!record) return null;

		let note = await Note.load(record.note_id);
		if (!note) return null;
		note = await this.ensureNoteHas3RSections(note);

		let tags: string[] = [];
		try {
			tags = JSON.parse(record.tags);
		} catch {
			tags = [];
		}

		return { record, note, tags };
	}

	public static async listRecords(options: { entryType?: string; limit?: number; offset?: number } = {}): Promise<RecordWithNote[]> {
		const records = await RecordDatabase.all(options);
		const results: RecordWithNote[] = [];

		for (const record of records) {
			let note = await Note.load(record.note_id);
			if (!note) continue;
			note = await this.ensureNoteHas3RSections(note);

			let tags: string[] = [];
			try {
				tags = JSON.parse(record.tags);
			} catch {
				tags = [];
			}

			results.push({ record, note, tags });
		}

		return results;
	}

	public static async recordCount(): Promise<number> {
		return await RecordDatabase.count();
	}
}

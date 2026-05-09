import SearchEngine from '@joplin/lib/services/search/SearchEngine';
import Note from '@joplin/lib/models/Note';
import Logger from '@joplin/utils/Logger';
import RecordDatabase from './RecordDatabase';
import { NoteEntity } from '@joplin/lib/services/database/types';

const logger = Logger.create('RecordSearchService');

export interface SearchResult {
	noteId: string;
	recordId: string;
	title: string;
	snippet: string;
	score: number;
	entryType: string;
	tags: string[];
	updatedTime: number;
}

// Simple tokenizer that handles both CJK and Latin text
function tokenize(text: string): string[] {
	if (!text) return [];
	const normalized = text.toLowerCase();
	const tokens: string[] = [];

	// Latin words
	const latinWords = normalized.match(/[a-z0-9]+/g);
	if (latinWords) tokens.push(...latinWords);

	// CJK characters — bigrams
	const cjkChars = normalized.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g);
	if (cjkChars) {
		for (let i = 0; i < cjkChars.length; i++) {
			tokens.push(cjkChars[i]);
			if (i < cjkChars.length - 1) {
				tokens.push(cjkChars[i] + cjkChars[i + 1]);
			}
		}
	}

	return tokens;
}

// Compute TF (term frequency) for a document
function computeTF(tokens: string[]): Map<string, number> {
	const tf = new Map<string, number>();
	for (const token of tokens) {
		tf.set(token, (tf.get(token) || 0) + 1);
	}
	// Normalize by document length
	const len = tokens.length || 1;
	for (const [key, value] of tf) {
		tf.set(key, value / len);
	}
	return tf;
}

// Compute IDF (inverse document frequency)
function computeIDF(documents: Map<string, number>[], vocabulary: Set<string>): Map<string, number> {
	const idf = new Map<string, number>();
	const N = documents.length || 1;

	for (const term of vocabulary) {
		let docCount = 0;
		for (const doc of documents) {
			if (doc.has(term)) docCount++;
		}
		idf.set(term, Math.log((N + 1) / (docCount + 1)) + 1);
	}

	return idf;
}

// Cosine similarity between two vectors
function cosineSimilarity(vecA: Map<string, number>, vecB: Map<string, number>): number {
	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (const [key, valA] of vecA) {
		const valB = vecB.get(key) || 0;
		dotProduct += valA * valB;
		normA += valA * valA;
	}

	for (const [, valB] of vecB) {
		normB += valB * valB;
	}

	const denominator = Math.sqrt(normA) * Math.sqrt(normB);
	return denominator === 0 ? 0 : dotProduct / denominator;
}

export default class RecordSearchService {
	// BM25 + TF-IDF hybrid search
	// Alpha controls the weight: higher = more BM25, lower = more semantic
	private static readonly ALPHA = 0.6;

	public static async search(query: string, limit = 50): Promise<SearchResult[]> {
		if (!query || !query.trim()) return [];

		await RecordDatabase.initialize();

		// Get all record note IDs to filter results
		const recordNoteIds = new Set(await RecordDatabase.noteIds());
		if (recordNoteIds.size === 0) return [];

		// Phase 1: BM25 search via Joplin's existing SearchEngine
		const bm25Results = await this.bm25Search(query, recordNoteIds);

		// Phase 2: Semantic (TF-IDF cosine similarity) search
		const semanticResults = await this.semanticSearch(query, recordNoteIds);

		// Phase 3: Merge and rank
		const merged = this.mergeResults(bm25Results, semanticResults);

		// Enrich with record metadata
		const enriched = await this.enrichResults(merged, limit);

		return enriched;
	}

	private static async bm25Search(query: string, recordNoteIds: Set<string>): Promise<Map<string, number>> {
		const scores = new Map<string, number>();

		try {
			const searchEngine = SearchEngine.instance();
			const results = await searchEngine.search(query, { appendWildCards: true });

			// Normalize BM25 scores to [0, 1] range
			let maxScore = 0;
			for (const row of results) {
				if (row.weight > maxScore) maxScore = row.weight;
			}

			for (const row of results) {
				const noteId = row.id || row.item_id;
				if (!noteId || !recordNoteIds.has(noteId)) continue;
				const normalizedScore = maxScore > 0 ? row.weight / maxScore : 0;
				scores.set(noteId, normalizedScore);
			}
		} catch (error) {
			logger.warn('BM25 search failed:', error);
		}

		return scores;
	}

	private static async semanticSearch(query: string, recordNoteIds: Set<string>): Promise<Map<string, number>> {
		const scores = new Map<string, number>();

		try {
			// Load record notes
			const noteIds = Array.from(recordNoteIds);
			const notes: NoteEntity[] = [];
			for (const id of noteIds) {
				const note = await Note.load(id, { fields: ['id', 'title', 'body'] });
				if (note) notes.push(note);
			}

			if (notes.length === 0) return scores;

			// Tokenize all documents
			const docTokens = notes.map(n => tokenize(`${n.title || ''} ${n.body || ''}`));
			const docTFs = docTokens.map(tokens => computeTF(tokens));

			// Build vocabulary
			const vocabulary = new Set<string>();
			for (const tf of docTFs) {
				for (const key of tf.keys()) {
					vocabulary.add(key);
				}
			}

			// Compute IDF
			const idf = computeIDF(docTFs, vocabulary);

			// Compute TF-IDF vectors for documents
			const docVectors = docTFs.map(tf => {
				const vec = new Map<string, number>();
				for (const [term, tfVal] of tf) {
					vec.set(term, tfVal * (idf.get(term) || 0));
				}
				return vec;
			});

			// Compute query TF-IDF vector
			const queryTokens = tokenize(query);
			const queryTF = computeTF(queryTokens);
			const queryVec = new Map<string, number>();
			for (const [term, tfVal] of queryTF) {
				queryVec.set(term, tfVal * (idf.get(term) || 1));
			}

			// Compute cosine similarity for each document
			let maxSim = 0;
			const sims: number[] = [];
			for (const docVec of docVectors) {
				const sim = cosineSimilarity(queryVec, docVec);
				sims.push(sim);
				if (sim > maxSim) maxSim = sim;
			}

			// Normalize to [0, 1]
			for (let i = 0; i < notes.length; i++) {
				const normalizedSim = maxSim > 0 ? sims[i] / maxSim : 0;
				if (normalizedSim > 0.01) {
					scores.set(notes[i].id, normalizedSim);
				}
			}
		} catch (error) {
			logger.warn('Semantic search failed:', error);
		}

		return scores;
	}

	private static mergeResults(
		bm25Scores: Map<string, number>,
		semanticScores: Map<string, number>,
	): Map<string, number> {
		const merged = new Map<string, number>();
		const allIds = new Set([...bm25Scores.keys(), ...semanticScores.keys()]);

		for (const id of allIds) {
			const bm25 = bm25Scores.get(id) || 0;
			const semantic = semanticScores.get(id) || 0;
			const hybridScore = this.ALPHA * bm25 + (1 - this.ALPHA) * semantic;
			merged.set(id, hybridScore);
		}

		return merged;
	}

	private static async enrichResults(merged: Map<string, number>, limit: number): Promise<SearchResult[]> {
		// Sort by score descending
		const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

		const results: SearchResult[] = [];

		for (const [noteId, score] of sorted) {
			const note = await Note.load(noteId, { fields: ['id', 'title', 'body', 'user_updated_time'] });
			if (!note) continue;

			const record = await RecordDatabase.loadByNoteId(noteId);
			if (!record) continue;

			let tags: string[] = [];
			try {
				tags = JSON.parse(record.tags);
			} catch {
				tags = [];
			}

			// Generate snippet
			const bodyText = note.body || '';
			const snippet = bodyText.length > 100 ? `${bodyText.substring(0, 100)}...` : bodyText;

			results.push({
				noteId: note.id,
				recordId: record.id,
				title: note.title || '',
				snippet,
				score,
				entryType: record.entry_type,
				tags,
				updatedTime: note.user_updated_time || 0,
			});
		}

		return results;
	}
}

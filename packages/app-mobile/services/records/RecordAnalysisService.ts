import Note from '@joplin/lib/models/Note';
import Resource from '@joplin/lib/models/Resource';
import Setting from '@joplin/lib/models/Setting';
import AlarmService from '@joplin/lib/services/AlarmService';
import { NoteEntity, ResourceEntity, ResourceOcrStatus } from '@joplin/lib/services/database/types';
import shim from '@joplin/lib/shim';
import uuid from '@joplin/lib/uuid';
import Logger from '@joplin/utils/Logger';
import { Buffer } from 'buffer';
import { NativeModules } from 'react-native';
import RecordDatabase, { RecordEntry, RecordFlashcard, RecordReflection } from './RecordDatabase';
import RecordService, { RecordWithNote } from './RecordService';
import { writeTextToCacheFile } from '../../utils/ShareUtils';
import unzip from '../voiceTyping/utils/unzip';

const md5 = require('md5');
const logger = Logger.create('RecordAnalysisService');

export interface RecordTimedTextSegment {
	text: string;
	timestampMs: number;
	durationMs: number;
}

export interface RecordFrameTextAlignment {
	framePath: string;
	timestampMs: number;
	frameSummary: string;
	text: string;
}

export interface RecordResourceMemory {
	id: string;
	title: string;
	mime: string;
	type: 'image' | 'audio' | 'video' | 'file';
	resourcePath?: string;
	ocrText: string;
	asrText: string;
	visualMemory: string;
	textMemory: string[];
	frameSummaries: string[];
	frameImagePaths: string[];
	frameTimestampsMs: number[];
	asrSegments: RecordTimedTextSegment[];
	frameTextAlignments: RecordFrameTextAlignment[];
	documentMarkdown?: string;
	documentMarkdownPath?: string;
	documentTextPath?: string;
	documentChunkPath?: string;
	documentChunks?: DoclingChunk[];
}

export interface MindMapNode {
	id: string;
	label: string;
	kind: 'record' | 'topic' | 'resource' | 'action';
}

export interface MindMapEdge {
	from: string;
	to: string;
	label: string;
}

export interface RecordReflectionPayload {
	recordId: string;
	noteId: string;
	title: string;
	generatedAt: number;
	sourceHash: string;
	textSummary: string;
	keyPoints: string[];
	recommendations: string[];
	keywords: string[];
	suggestedTags: string[];
	llmProvider: 'configured' | 'local-fallback';
	textMemory: {
		embedding: { token: string; weight: number }[];
		summary: string;
	};
	imageMemories: RecordResourceMemory[];
	audioTranscripts: RecordResourceMemory[];
	videoBreakdown: RecordResourceMemory[];
	documentMemories: RecordResourceMemory[];
	relations: { from: string; to: string; relation: string }[];
	mindMap: {
		nodes: MindMapNode[];
		edges: MindMapEdge[];
	};
	markdown: string;
}

interface LlmReflectResult {
	textSummary: string;
	keyPoints: string[];
	recommendations: string[];
	suggestedTags: string[];
}

interface LlmMessagePart {
	type: 'text' | 'image_url';
	text?: string;
	image_url?: { url: string };
}

interface LlmMessage {
	role: 'system' | 'user';
	content: string | LlmMessagePart[];
}

interface LlmResponseInputText {
	type: 'input_text';
	text: string;
}

interface LlmResponseInputImage {
	type: 'input_image';
	image_url: string;
	detail: 'auto';
}

type LlmResponseInputPart = LlmResponseInputText | LlmResponseInputImage;

interface DoclingChunk {
	id: string;
	heading: string;
	text: string;
	index: number;
}

interface DoclingDocumentConversion {
	markdown: string;
	text: string;
	chunks: DoclingChunk[];
	markdownPath: string;
	textPath: string;
	chunkPath: string;
}

interface ResourceTextEntry {
	llmText: string;
	docling?: DoclingDocumentConversion;
}

interface NativeRecordMediaAnalysis {
	extractVideoFrames?(videoPath: string, outputDir: string, count: number): Promise<unknown[]>;
	extractAudioText?(audioPath: string): Promise<string>;
	extractAudioSegments?(audioPath: string): Promise<unknown[]>;
	extractImageText?(imagePath: string): Promise<string>;
	extractVideoAudioText?(videoPath: string): Promise<string>;
	extractVideoAudioSegments?(videoPath: string): Promise<unknown[]>;
}

interface AnalyzeOptions {
	requireConfiguredLlm?: boolean;
	reflectPrompt?: string;
}

interface LlmConfig {
	slot: 'primary' | 'fallback' | 'third';
	label: string;
	provider: LlmProvider;
	apiKey: string;
	baseUrl: string;
	model: string;
}

type LlmProvider = 'openai' | 'openrouter' | 'google';

export interface LlmModelOption {
	id: string;
	name: string;
	contextLength: number;
	isFree: boolean;
	pricingLabel: string;
}

export interface GeneratedRecordMedia {
	uri: string;
	fileName: string;
	type: string;
}

export interface RecordDashboardStats {
	weeklyRecords: number;
	totalRecords: number;
	reflections: number;
	flashcards: number;
	dueFlashcards: number;
	shares: number;
	followers: number;
	wordCloud: { word: string; weight: number }[];
	progress: {
		record: number;
		reflect: number;
		refine: number;
		share: number;
	};
}

export interface FeynmanTeachingMaterial {
	title: string;
	slides: FeynmanSlide[];
	script: string;
	markdown: string;
	markdownPath: string;
	pdfPath: string;
	scriptPath: string;
	jsonPath: string;
}

export interface FeynmanSlide {
	title: string;
	visualPrompt: string;
	bullets: string[];
	speakerNotes: string;
}

const socialTargetNames: Record<string, string> = {
	discord: 'Discord',
	instagram: 'Instagram',
	youtube: 'YouTube',
};

const stripMarkdownResources = (text: string) => {
	return text
		.replace(/!\[[^\]]*]\(:\/[a-zA-Z0-9]+\)/g, ' ')
		.replace(/\[[^\]]*]\(:\/[a-zA-Z0-9]+\)/g, ' ')
		.replace(/<iframe[\s\S]*?<\/iframe>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
};

const sectionPattern = (section: 'Record' | 'Reflect' | 'Refine') => new RegExp(`(^|\\n)# ${section}\\n([\\s\\S]*?)(?=\\n# (?:Record|Reflect|Refine)\\n|$)`);

const markdownSection = (body: string, section: 'Record' | 'Reflect' | 'Refine') => {
	const match = body.match(sectionPattern(section));
	return match?.[2]?.trim() || '';
};

const markdownSubsection = (content: string, heading: string) => {
	const marker = `## ${heading}`;
	const startIndex = content.indexOf(marker);
	if (startIndex < 0) return '';
	const section = content.slice(startIndex);
	const nextHeadingIndex = section.slice(marker.length).search(/\n## /);
	return nextHeadingIndex < 0 ? section.trim() : section.slice(0, marker.length + nextHeadingIndex).trim();
};

const markdownHeadingContent = (content: string, heading: string) => {
	const subsection = markdownSubsection(content, heading);
	if (!subsection) return '';
	return subsection.split('\n').slice(1).join('\n').trim();
};

const markdownListItems = (content: string, heading: string) => {
	return markdownHeadingContent(content, heading)
		.split('\n')
		.map(line => line.trim().replace(/^[-*]\s+/, ''))
		.filter(Boolean);
};

const replaceMarkdownSection = (body: string, section: 'Record' | 'Reflect' | 'Refine', content: string) => {
	const normalizedContent = content.trim() || '_等待生成。_';
	const pattern = sectionPattern(section);
	if (pattern.test(body)) {
		return body.replace(pattern, (match) => {
			const prefix = match.startsWith('\n') ? '\n' : '';
			return `${prefix}# ${section}\n${normalizedContent}`;
		});
	}

	return `${body.trim()}\n\n# ${section}\n${normalizedContent}`.trim();
};

const splitSentences = (text: string) => {
	return text
		.replace(/\r/g, '\n')
		.split(/(?<=[。！？.!?])\s+|\n+/)
		.map(line => line.trim())
		.filter(line => line.length > 0);
};

const tokenize = (text: string) => {
	const tokens = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.split(/\s+/)
		.map(token => token.trim())
		.filter(token => token.length >= 2);

	const cjkTokens = Array.from(text.matchAll(/[\u4e00-\u9fff]{2,6}/g)).map(match => match[0]);
	return tokens.concat(cjkTokens);
};

const topKeywords = (text: string, limit: number) => {
	const weights = new Map<string, number>();
	for (const token of tokenize(text)) {
		weights.set(token, (weights.get(token) ?? 0) + Math.min(4, token.length));
	}
	return Array.from(weights.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([token, weight]) => ({ token, weight }));
};

const keywordRelations = (keywords: string[], keyPoints: string[]) => {
	const limitedKeywords = keywords.slice(0, 6);
	const relations: { from: string; to: string; relation: string }[] = [];
	const seen = new Set<string>();
	const pushRelation = (from: string, to: string, relation: string) => {
		if (!from || !to || from === to) return;
		const key = [from, to].sort().concat(relation).join('::');
		if (seen.has(key)) return;
		seen.add(key);
		relations.push({ from, to, relation });
	};
	for (const point of keyPoints) {
		const lowerPoint = point.toLowerCase();
		const matches = limitedKeywords.filter(keyword => lowerPoint.includes(keyword.toLowerCase()));
		for (let index = 0; index < matches.length - 1; index++) {
			pushRelation(matches[index], matches[index + 1], `共同解释：${point.slice(0, 32)}`);
		}
	}
	if (!relations.length && limitedKeywords.length > 1) {
		for (const keyword of limitedKeywords.slice(1)) {
			pushRelation(limitedKeywords[0], keyword, '同一记录中的关联主题');
		}
	}
	return relations.slice(0, 12);
};

const summarize = (text: string, title: string) => {
	const sentences = splitSentences(stripMarkdownResources(text));
	if (!sentences.length) return title || '这条记录主要由附件构成，文字内容较少。';
	return sentences.slice(0, 4).join('\n');
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
};

const stringArray = (value: unknown) => {
	if (Array.isArray(value)) return value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean);
	if (typeof value === 'string') return splitSentences(value);
	return [];
};

const numberArray = (value: unknown) => {
	if (!Array.isArray(value)) return [];
	return value.filter(item => typeof item === 'number');
};

const timedTextSegments = (value: unknown): RecordTimedTextSegment[] => {
	if (!Array.isArray(value)) return [];
	return value.map(item => {
		const record = asRecord(item);
		return {
			text: firstString(record?.text),
			timestampMs: typeof record?.timestampMs === 'number' ? record.timestampMs : 0,
			durationMs: typeof record?.durationMs === 'number' ? record.durationMs : 0,
		};
	}).filter(item => item.text);
};

const frameTextAlignments = (value: unknown): RecordFrameTextAlignment[] => {
	if (!Array.isArray(value)) return [];
	return value.map(item => {
		const record = asRecord(item);
		return {
			framePath: firstString(record?.framePath),
			timestampMs: typeof record?.timestampMs === 'number' ? record.timestampMs : 0,
			frameSummary: firstString(record?.frameSummary),
			text: firstString(record?.text),
		};
	}).filter(item => item.framePath || item.frameSummary || item.text);
};

const recordResourceMemoryArray = (value: unknown): RecordResourceMemory[] => {
	if (!Array.isArray(value)) return [];
	return value.map(item => {
		const record = asRecord(item);
		return {
			id: firstString(record?.id),
			title: firstString(record?.title),
			mime: firstString(record?.mime),
			type: ['image', 'audio', 'video', 'file'].includes(firstString(record?.type)) ? firstString(record?.type) as RecordResourceMemory['type'] : 'file',
			resourcePath: firstString(record?.resourcePath),
			ocrText: firstString(record?.ocrText),
			asrText: firstString(record?.asrText),
			visualMemory: firstString(record?.visualMemory),
			textMemory: stringArray(record?.textMemory),
			frameSummaries: stringArray(record?.frameSummaries),
			frameImagePaths: stringArray(record?.frameImagePaths),
			frameTimestampsMs: numberArray(record?.frameTimestampsMs),
			asrSegments: timedTextSegments(record?.asrSegments),
			frameTextAlignments: frameTextAlignments(record?.frameTextAlignments),
			documentMarkdown: firstString(record?.documentMarkdown),
			documentMarkdownPath: firstString(record?.documentMarkdownPath),
			documentTextPath: firstString(record?.documentTextPath),
			documentChunkPath: firstString(record?.documentChunkPath),
			documentChunks: Array.isArray(record?.documentChunks) ? record.documentChunks.map((chunkValue, index) => {
				const chunk = asRecord(chunkValue);
				return {
					id: firstString(chunk?.id, `chunk:${index}`),
					heading: firstString(chunk?.heading),
					text: firstString(chunk?.text),
					index: typeof chunk?.index === 'number' ? chunk.index : index,
				};
			}).filter(chunk => chunk.text) : [],
		};
	});
};

const normalizeReflectionPayload = (payload: unknown, recordId: string): RecordReflectionPayload => {
	const root = asRecord(payload) ?? {};
	const textMemory = asRecord(root.textMemory) ?? {};
	const mindMap = asRecord(root.mindMap) ?? {};
	const nodes = Array.isArray(mindMap.nodes) ? mindMap.nodes.map(item => {
		const node = asRecord(item);
		const kind = firstString(node?.kind);
		return {
			id: firstString(node?.id),
			label: firstString(node?.label),
			kind: ['record', 'topic', 'resource', 'action'].includes(kind) ? kind as MindMapNode['kind'] : 'topic',
		};
	}).filter(node => node.id && node.label) : [];
	const edges = Array.isArray(mindMap.edges) ? mindMap.edges.map(item => {
		const edge = asRecord(item);
		return {
			from: firstString(edge?.from),
			to: firstString(edge?.to),
			label: firstString(edge?.label),
		};
	}).filter(edge => edge.from && edge.to) : [];
	const title = firstString(root.title, '3R Reflect');
	const textSummary = firstString(root.textSummary, root.summary, '暂无复盘总结。');
	const normalized: Omit<RecordReflectionPayload, 'markdown'> = {
		recordId: firstString(root.recordId, recordId),
		noteId: firstString(root.noteId),
		title,
		generatedAt: typeof root.generatedAt === 'number' ? root.generatedAt : Date.now(),
		sourceHash: firstString(root.sourceHash),
		textSummary,
		keyPoints: stringArray(root.keyPoints),
		recommendations: stringArray(root.recommendations),
		keywords: stringArray(root.keywords),
		suggestedTags: stringArray(root.suggestedTags),
		llmProvider: root.llmProvider === 'configured' ? 'configured' : 'local-fallback',
		textMemory: {
			embedding: Array.isArray(textMemory.embedding) ? textMemory.embedding.map(item => {
				const itemRecord = asRecord(item);
				return {
					token: firstString(itemRecord?.token),
					weight: typeof itemRecord?.weight === 'number' ? itemRecord.weight : 1,
				};
			}).filter(item => item.token) : numberArray(root.embedding).map((weight, index) => ({ token: `token-${index + 1}`, weight })),
			summary: firstString(textMemory.summary, textSummary),
		},
		imageMemories: recordResourceMemoryArray(root.imageMemories),
		audioTranscripts: recordResourceMemoryArray(root.audioTranscripts),
		videoBreakdown: recordResourceMemoryArray(root.videoBreakdown),
		documentMemories: recordResourceMemoryArray(root.documentMemories),
		relations: Array.isArray(root.relations) ? root.relations.map(item => {
			const relation = asRecord(item);
			return {
				from: firstString(relation?.from),
				to: firstString(relation?.to),
				relation: firstString(relation?.relation),
			};
		}).filter(item => item.from && item.to) : [],
		mindMap: { nodes, edges },
	};
	return {
		...normalized,
		markdown: firstString(root.markdown) || reflectionToMarkdown(normalized),
	};
};

const firstString = (...values: unknown[]) => {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return '';
};

const chatAssistantContent = (json: unknown) => {
	const root = asRecord(json);
	const choices = root?.choices;
	if (!Array.isArray(choices)) return '';
	const firstChoice = asRecord(choices[0]);
	const message = asRecord(firstChoice?.message);
	return firstString(message?.content);
};

const responseAssistantContent = (json: unknown) => {
	const root = asRecord(json);
	const outputText = firstString(root?.output_text);
	if (outputText) return outputText;
	const output = root?.output;
	if (!Array.isArray(output)) return '';
	const chunks: string[] = [];
	for (const itemValue of output) {
		const item = asRecord(itemValue);
		const content = item?.content;
		if (!Array.isArray(content)) continue;
		for (const partValue of content) {
			const part = asRecord(partValue);
			if (part?.type === 'output_text') {
				const text = firstString(part.text);
				if (text) chunks.push(text);
			}
		}
	}
	return chunks.join('\n').trim();
};

const parseJsonObjectFromText = (text: string) => {
	try {
		return asRecord(JSON.parse(text));
	} catch (error) {
		const startIndex = text.indexOf('{');
		const endIndex = text.lastIndexOf('}');
		if (startIndex < 0 || endIndex <= startIndex) return null;
		try {
			return asRecord(JSON.parse(text.slice(startIndex, endIndex + 1)));
		} catch (nestedError) {
			logger.warn('Failed to parse LLM JSON response:', nestedError);
			return null;
		}
	}
};

const llmEndpointUrl = (baseUrl: string) => {
	return baseUrl.trim();
};

const openAiChatCompletionsUrl = 'https://api.openai.com/v1/chat/completions';
const openAiImageGenerationsUrl = 'https://api.openai.com/v1/images/generations';
const openRouterChatCompletionsUrl = 'https://openrouter.ai/api/v1/chat/completions';
const geminiChatCompletionsUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const geminiApiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
const openRouterModelsUrl = 'https://openrouter.ai/api/v1/models';
const openAiImageModel = 'gpt-image-2';
const googleVeoModel = 'veo-3.1-generate-preview';

const normalizeLlmProvider = (value: unknown): LlmProvider => {
	if (value === 'google') return 'google';
	return value === 'openrouter' ? 'openrouter' : 'openai';
};

const defaultReflectPrompt = [
	'You are the Reflect engine for a 3R Journal mobile app.',
	'Use a growth mindset: treat the record as evidence for learning, not judgment.',
	'Build a structured, systematic reflection that separates observations, patterns, principles, next actions, and review cues.',
	'Return compact JSON only with textSummary, keyPoints, recommendations, and suggestedTags arrays.',
	'Analyze the actual text, documents, OCR/ASR, and video frame images provided by the app.',
].join(' ');

const providerEndpointUrl = (provider: LlmProvider, baseUrl: string) => {
	const configuredUrl = baseUrl.trim();
	if (provider === 'openrouter' && (!configuredUrl || configuredUrl === openAiChatCompletionsUrl)) return openRouterChatCompletionsUrl;
	if (provider === 'google' && (!configuredUrl || configuredUrl === openAiChatCompletionsUrl || configuredUrl === openRouterChatCompletionsUrl)) return geminiChatCompletionsUrl;
	if (provider === 'openai' && (!configuredUrl || configuredUrl === openRouterChatCompletionsUrl || configuredUrl === geminiChatCompletionsUrl)) return openAiChatCompletionsUrl;
	if (configuredUrl) return configuredUrl;
	if (provider === 'google') return geminiChatCompletionsUrl;
	return provider === 'openrouter' ? openRouterChatCompletionsUrl : openAiChatCompletionsUrl;
};

const llmConfigFromSettings = (slot: 'primary' | 'fallback' | 'third'): LlmConfig => {
	const suffix = slot === 'third' ? '3' : slot === 'fallback' ? '2' : '';
	const provider = normalizeLlmProvider(Setting.value(`threeR.llmProvider${suffix}`));
	return {
		slot,
		label: slot === 'third' ? 'Third model' : slot === 'fallback' ? 'Fallback model' : 'Primary model',
		provider,
		apiKey: `${Setting.value(`threeR.llmApiKey${suffix}`) || ''}`.trim(),
		baseUrl: providerEndpointUrl(provider, `${Setting.value(`threeR.llmBaseUrl${suffix}`) || ''}`),
		model: `${Setting.value(`threeR.llmModel${suffix}`) || ''}`.trim(),
	};
};

const llmConfigsFromSettings = () => [llmConfigFromSettings('primary'), llmConfigFromSettings('fallback'), llmConfigFromSettings('third')];

const configuredLlmConfigsFromSettings = () => {
	const seen = new Set<string>();
	const output: LlmConfig[] = [];
	for (const config of llmConfigsFromSettings()) {
		if (!config.apiKey || !config.baseUrl || !config.model) continue;
		const key = `${config.provider}:${config.baseUrl}:${config.model}:${config.apiKey.slice(0, 8)}:${config.apiKey.slice(-8)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(config);
	}
	return output;
};

const llmRequestHeaders = (config: LlmConfig) => {
	const headers: Record<string, string> = {
		'Authorization': `Bearer ${config.apiKey}`,
		'Content-Type': 'application/json',
	};
	if (config.provider === 'openrouter') {
		headers['HTTP-Referer'] = 'https://joplinapp.org';
		headers['X-Title'] = 'Joplin 3R Journal';
	}
	return headers;
};

const maskedApiKey = (apiKey: string) => {
	if (!apiKey) return 'not configured';
	if (apiKey.length <= 8) return 'configured';
	return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
};

const llmProviderLabel = (provider: LlmProvider) => {
	if (provider === 'openrouter') return 'OpenRouter';
	if (provider === 'google') return 'Google Gemini';
	return 'OpenAI';
};

const configuredLlmConfigForProvider = (provider: LlmProvider) => {
	return llmConfigsFromSettings().find(config => config.provider === provider && config.apiKey);
};

const writeBase64MediaToCache = async (base64: string, fileName: string) => {
	const filePath = `${shim.fsDriver().getCacheDirectoryPath()}/${fileName}`;
	await shim.fsDriver().writeFile(filePath, base64, 'base64');
	return filePath;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const firstGeneratedVideoUri = (root: unknown) => {
	const response = asRecord(asRecord(root)?.response);
	const generateVideoResponse = asRecord(response?.generateVideoResponse);
	const generatedSamples = generateVideoResponse?.generatedSamples;
	const generatedVideos = response?.generatedVideos;
	const sample = Array.isArray(generatedSamples) ? asRecord(generatedSamples[0]) : Array.isArray(generatedVideos) ? asRecord(generatedVideos[0]) : null;
	return firstString(asRecord(sample?.video)?.uri);
};

const firstGeneratedVideoBase64 = (root: unknown) => {
	const response = asRecord(asRecord(root)?.response);
	const generatedVideos = response?.generatedVideos;
	const sample = Array.isArray(generatedVideos) ? asRecord(generatedVideos[0]) : null;
	return firstString(asRecord(sample?.video)?.videoBytes);
};

const normalizeLocalFilePath = (uri: string) => {
	return decodeURIComponent(uri).replace(/^file:\/\//, '');
};

const isZeroPrice = (value: unknown) => {
	const price = typeof value === 'string' ? Number(value) : value;
	return typeof price === 'number' && Number.isFinite(price) && price === 0;
};

const priceNumber = (value: unknown) => {
	const price = typeof value === 'string' ? Number(value) : value;
	return typeof price === 'number' && Number.isFinite(price) ? price : null;
};

const priceLabel = (prompt: unknown, completion: unknown) => {
	const promptPrice = priceNumber(prompt);
	const completionPrice = priceNumber(completion);
	if (promptPrice === null || completionPrice === null) return '';
	if (promptPrice === 0 && completionPrice === 0) return 'free';
	return `$${promptPrice}/$${completionPrice}`;
};

const openRouterModelFromJson = (value: unknown): LlmModelOption | null => {
	const model = asRecord(value);
	const pricing = asRecord(model?.pricing);
	const architecture = asRecord(model?.architecture);
	const outputModalities = architecture?.output_modalities;
	const id = firstString(model?.id);
	if (!id || !pricing) return null;
	if (Array.isArray(outputModalities) && !outputModalities.includes('text')) return null;
	const isFree = isZeroPrice(pricing.prompt) && isZeroPrice(pricing.completion) && isZeroPrice(pricing.request);
	return {
		id,
		name: firstString(model?.name, id),
		contextLength: typeof model?.context_length === 'number' ? model.context_length : 0,
		isFree,
		pricingLabel: priceLabel(pricing.prompt, pricing.completion),
	};
};

const isResponsesEndpoint = (url: string) => {
	return /\/responses\/?$/i.test(url.trim());
};

const responseInputContent = (content: string | LlmMessagePart[]): LlmResponseInputPart[] => {
	if (typeof content === 'string') return [{ type: 'input_text', text: content }];
	const output: LlmResponseInputPart[] = [];
	for (const part of content) {
		if (part.type === 'text') {
			output.push({ type: 'input_text', text: part.text || '' });
		} else if (part.image_url?.url) {
			output.push({ type: 'input_image', image_url: part.image_url.url, detail: 'auto' });
		}
	}
	return output;
};

const usesReasoningChatParameters = (model: string) => {
	return /^(o\d|o-|gpt-5)/i.test(model.trim());
};

const supportsMaxCompletionTokens = (config: LlmConfig) => {
	const trimmed = config.baseUrl.trim().replace(/\/+$/, '');
	return /^https:\/\/api\.openai\.com(?:\/v1)?(?:\/chat\/completions)?$/i.test(trimmed) || usesReasoningChatParameters(config.model);
};

const chatCompletionOptions = (config: LlmConfig, temperature: number, outputTokenLimit?: number) => {
	const options: Record<string, number> = {};
	if (!usesReasoningChatParameters(config.model)) options.temperature = temperature;
	if (outputTokenLimit) {
		if (supportsMaxCompletionTokens(config)) {
			options.max_completion_tokens = outputTokenLimit;
		} else {
			options.max_tokens = outputTokenLimit;
		}
	}
	return options;
};

const callLlmText = async (config: LlmConfig, systemPrompt: string, userContent: string | LlmMessagePart[], temperature: number, outputTokenLimit?: number) => {
	const url = llmEndpointUrl(config.baseUrl);
	const usesResponses = isResponsesEndpoint(url);
	const response = await fetch(url, {
		method: 'POST',
		headers: llmRequestHeaders(config),
		body: JSON.stringify(usesResponses ? {
			model: config.model,
			instructions: systemPrompt,
			input: [
				{
					role: 'user',
					content: responseInputContent(userContent),
				},
			],
			...(outputTokenLimit ? { max_output_tokens: outputTokenLimit } : {}),
		} : {
			model: config.model,
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userContent },
			],
			...chatCompletionOptions(config, temperature, outputTokenLimit),
		}),
	});
	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(`${config.label} ${config.provider}/${config.model} failed: ${response.status} ${responseText}`);
	}
	const responseJson = JSON.parse(responseText);
	return usesResponses ? responseAssistantContent(responseJson) : chatAssistantContent(responseJson);
};

const callLlmTextWithFallback = async (systemPrompt: string, userContent: string | LlmMessagePart[], temperature: number, outputTokenLimit?: number) => {
	const errors: string[] = [];
	for (const config of configuredLlmConfigsFromSettings()) {
		try {
			return await callLlmText(config, systemPrompt, userContent, temperature, outputTokenLimit);
		} catch (error) {
			errors.push(`${error}`);
			logger.warn('3R LLM model failed, trying fallback if configured:', error);
		}
	}
	if (errors.length) throw new Error(errors.join('\n'));
	return '';
};

const decodeXmlEntities = (text: string) => {
	return text
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, '\'')
		.replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => String.fromCharCode(parseInt(code, 16)));
};

const xmlToText = (xml: string) => {
	return decodeXmlEntities(xml)
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
};

const resourceExtension = (resource: ResourceEntity) => {
	const title = `${resource.title || ''}`.toLowerCase();
	const match = title.match(/\.([a-z0-9]+)$/);
	return match?.[1] || `${resource.file_extension || ''}`.toLowerCase();
};

const isZipOfficeResource = (resource: ResourceEntity) => {
	const ext = resourceExtension(resource);
	return ['docx', 'pptx', 'xlsx'].includes(ext);
};

const isTextResource = (resource: ResourceEntity) => {
	const mime = resource.mime || '';
	const ext = resourceExtension(resource);
	return mime.startsWith('text/') || ['md', 'txt', 'csv', 'json', 'xml', 'html'].includes(ext);
};

const officeXmlPaths = (resource: ResourceEntity, paths: string[]) => {
	const ext = resourceExtension(resource);
	if (ext === 'docx') return paths.filter(path => path === 'word/document.xml' || path.startsWith('word/header') || path.startsWith('word/footer'));
	if (ext === 'pptx') return paths.filter(path => path.startsWith('ppt/slides/slide') && path.endsWith('.xml'));
	if (ext === 'xlsx') return paths.filter(path => path === 'xl/sharedStrings.xml' || (path.startsWith('xl/worksheets/sheet') && path.endsWith('.xml')));
	return [];
};

const resourceType = (mime: string): RecordResourceMemory['type'] => {
	if (mime.startsWith('image/')) return 'image';
	if (mime.startsWith('audio/')) return 'audio';
	if (mime.startsWith('video/')) return 'video';
	return 'file';
};

interface ExtractedVideoFrame {
	path: string;
	timestampMs: number;
}

const formatTimestamp = (timestampMs: number) => {
	const totalSeconds = Math.max(0, Math.round(timestampMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const speechSegmentsToText = (segments: RecordTimedTextSegment[]) => {
	return segments.map(segment => segment.text).join(' ').replace(/\s+/g, ' ').trim();
};

const segmentOverlapsTimestamp = (segment: RecordTimedTextSegment, timestampMs: number, toleranceMs: number) => {
	const start = segment.timestampMs;
	const end = segment.timestampMs + Math.max(segment.durationMs, 1000);
	return timestampMs >= start - toleranceMs && timestampMs <= end + toleranceMs;
};

const textNearTimestamp = (segments: RecordTimedTextSegment[], timestampMs: number) => {
	const nearby = segments.filter(segment => segmentOverlapsTimestamp(segment, timestampMs, 2500));
	if (nearby.length) return speechSegmentsToText(nearby);
	if (!segments.length) return '';
	const sorted = segments.slice().sort((a, b) => Math.abs(a.timestampMs - timestampMs) - Math.abs(b.timestampMs - timestampMs));
	return speechSegmentsToText(sorted.slice(0, 2));
};

const makeFrameSummaries = (resource: ResourceEntity, frames: ExtractedVideoFrame[], frameDescriptions: string[] = []) => {
	const text = `${resource.ocr_text || ''}`.trim();
	const chunks = splitSentences(text);
	if (!(resource.mime || '').startsWith('video/')) return [];
	if (frameDescriptions.length) {
		return frameDescriptions.slice(0, 6).map((description, index) => `抽帧 ${index + 1} (${formatTimestamp(frames[index]?.timestampMs || 0)}): ${description}`);
	}
	if (chunks.length) {
		return chunks.slice(0, 6).map((chunk, index) => `片段 ${index + 1}: ${chunk}`);
	}
	if (frames.length) {
		return frames.map((frame, index) => `抽帧 ${index + 1} (${formatTimestamp(frame.timestampMs)}): ${frame.path}`);
	}
	return [
		`片段 1: 检测到视频资源 ${resource.title || resource.id}，等待媒体 OCR/ASR 后可回放更细的逐帧摘要。`,
	];
};

const alignFramesWithSpeech = (frames: ExtractedVideoFrame[], frameDescriptions: string[], segments: RecordTimedTextSegment[]): RecordFrameTextAlignment[] => {
	return frames.map((frame, index) => ({
		framePath: frame.path,
		timestampMs: frame.timestampMs,
		frameSummary: frameDescriptions[index] || `抽帧 ${index + 1}`,
		text: textNearTimestamp(segments, frame.timestampMs),
	}));
};

const extractOfficeText = async (resource: ResourceEntity) => {
	const sourcePath = Resource.fullPath(resource);
	const extractDir = `${shim.fsDriver().getCacheDirectoryPath()}/3r-office-extract/${resource.id}-${Date.now()}`;
	try {
		await unzip(sourcePath, extractDir);
		const entries = await shim.fsDriver().readDirStats(extractDir, { recursive: true });
		const paths = entries.filter(entry => !entry.isDirectory()).map(entry => entry.path);
		const selectedPaths = officeXmlPaths(resource, paths);
		const textParts: string[] = [];
		for (const path of selectedPaths.slice(0, 80)) {
			const xml = await shim.fsDriver().readFile(`${extractDir}/${path}`, 'utf8');
			const text = xmlToText(xml);
			if (text) textParts.push(text);
		}
		return textParts.join('\n').trim();
	} catch (error) {
		logger.warn('Failed to extract Office resource text:', resource.id, error);
		return '';
	} finally {
		try {
			if (await shim.fsDriver().exists(extractDir)) await shim.fsDriver().remove(extractDir);
		} catch (error) {
			logger.warn('Failed to clean Office extraction directory:', error);
		}
	}
};

const extractPdfText = async (resource: ResourceEntity) => {
	try {
		const pages = await shim.pdfExtractEmbeddedText(Resource.fullPath(resource));
		return pages.join('\n').trim();
	} catch (error) {
		logger.warn('Failed to extract PDF text:', resource.id, error);
		return '';
	}
};

const extractPlainText = async (resource: ResourceEntity) => {
	try {
		const text = await shim.fsDriver().readFile(Resource.fullPath(resource), 'utf8');
		return text.slice(0, 120000);
	} catch (error) {
		logger.warn('Failed to read text resource:', resource.id, error);
		return '';
	}
};

const markdownTitle = (resource: ResourceEntity) => resource.title || resource.id || 'document';

const extractPdfMarkdown = async (resource: ResourceEntity) => {
	try {
		const pages = await shim.pdfExtractEmbeddedText(Resource.fullPath(resource));
		const sections = pages.map((pageText, index) => {
			const text = pageText.trim();
			return text ? `## Page ${index + 1}\n\n${text}` : '';
		}).filter(Boolean);
		return sections.length ? `# ${markdownTitle(resource)}\n\n${sections.join('\n\n')}` : '';
	} catch (error) {
		logger.warn('Failed to extract PDF markdown:', resource.id, error);
		return '';
	}
};

const officePathTitle = (path: string) => {
	const slideMatch = path.match(/ppt\/slides\/slide(\d+)\.xml$/);
	if (slideMatch) return `Slide ${slideMatch[1]}`;
	const sheetMatch = path.match(/xl\/worksheets\/sheet(\d+)\.xml$/);
	if (sheetMatch) return `Sheet ${sheetMatch[1]}`;
	if (path === 'xl/sharedStrings.xml') return 'Shared strings';
	if (path.startsWith('word/header')) return 'Header';
	if (path.startsWith('word/footer')) return 'Footer';
	return 'Document';
};

const extractOfficeMarkdown = async (resource: ResourceEntity) => {
	const sourcePath = Resource.fullPath(resource);
	const extractDir = `${shim.fsDriver().getCacheDirectoryPath()}/3r-office-extract/${resource.id}-${Date.now()}`;
	try {
		await unzip(sourcePath, extractDir);
		const entries = await shim.fsDriver().readDirStats(extractDir, { recursive: true });
		const paths = entries.filter(entry => !entry.isDirectory()).map(entry => entry.path);
		const selectedPaths = officeXmlPaths(resource, paths);
		const sections: string[] = [];
		for (const path of selectedPaths.slice(0, 120)) {
			const xml = await shim.fsDriver().readFile(`${extractDir}/${path}`, 'utf8');
			const text = xmlToText(xml);
			if (text) sections.push(`## ${officePathTitle(path)}\n\n${text}`);
		}
		return sections.length ? `# ${markdownTitle(resource)}\n\n${sections.join('\n\n')}` : '';
	} catch (error) {
		logger.warn('Failed to extract Office markdown:', resource.id, error);
		return '';
	} finally {
		try {
			if (await shim.fsDriver().exists(extractDir)) await shim.fsDriver().remove(extractDir);
		} catch (error) {
			logger.warn('Failed to clean Office extraction directory:', error);
		}
	}
};

const extractPlainMarkdown = async (resource: ResourceEntity) => {
	const text = await extractPlainText(resource);
	if (!text) return '';
	const ext = resourceExtension(resource);
	if (ext === 'md' || ext === 'markdown') return text;
	if (ext === 'csv') return `# ${markdownTitle(resource)}\n\n\`\`\`csv\n${text}\n\`\`\``;
	if (ext === 'json') return `# ${markdownTitle(resource)}\n\n\`\`\`json\n${text}\n\`\`\``;
	if (ext === 'html' || ext === 'htm') return `# ${markdownTitle(resource)}\n\n${xmlToText(text)}`;
	return `# ${markdownTitle(resource)}\n\n${text}`;
};

const extractedMarkdownForResource = async (resource: ResourceEntity) => {
	const mime = resource.mime || '';
	const ext = resourceExtension(resource);
	if (mime === 'application/pdf' || ext === 'pdf') return await extractPdfMarkdown(resource);
	if (isZipOfficeResource(resource)) return await extractOfficeMarkdown(resource);
	if (isTextResource(resource)) return await extractPlainMarkdown(resource);
	return '';
};

const markdownToPlainText = (markdown: string) => {
	return markdown
		.replace(/```[\s\S]*?```/g, match => match.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```$/g, ''))
		.replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
		.replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/^\s*[-*+]\s+/gm, '')
		.replace(/^\s*\d+\.\s+/gm, '')
		.replace(/[*_`>]/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
};

const chunkMarkdown = (resource: ResourceEntity, markdown: string): DoclingChunk[] => {
	const maxChunkLength = 2800;
	const blocks = markdown
		.replace(/\r/g, '\n')
		.split(/\n{2,}/)
		.map(block => block.trim())
		.filter(Boolean);
	const chunks: DoclingChunk[] = [];
	let current = '';
	let heading = markdownTitle(resource);
	const pushChunk = () => {
		const text = current.trim();
		if (!text) return;
		chunks.push({
			id: `${resource.id}:chunk:${chunks.length + 1}`,
			heading,
			text,
			index: chunks.length,
		});
		current = '';
	};

	for (const block of blocks) {
		const headingMatch = block.match(/^#{1,6}\s+(.+)$/m);
		if (headingMatch?.[1]) heading = headingMatch[1].trim();
		if (current && current.length + block.length + 2 > maxChunkLength) pushChunk();
		current = current ? `${current}\n\n${block}` : block;
	}
	pushChunk();
	return chunks.slice(0, 80);
};

const convertDocumentWithDocling = async (resource: ResourceEntity): Promise<DoclingDocumentConversion | undefined> => {
	const markdown = await extractedMarkdownForResource(resource);
	if (!markdown) return undefined;
	const text = markdownToPlainText(markdown);
	const chunks = chunkMarkdown(resource, markdown);
	const markdownPath = await writeTextToCacheFile(markdown, `3r-docling-${resource.id}.md`);
	const textPath = await writeTextToCacheFile(text, `3r-docling-${resource.id}.txt`);
	const chunkPath = await writeTextToCacheFile(JSON.stringify(chunks, null, 2), `3r-docling-${resource.id}.chunks.json`);
	return { markdown, text, chunks, markdownPath, textPath, chunkPath };
};

const doclingTextForLlm = (conversion: DoclingDocumentConversion) => {
	const chunkText = conversion.chunks.slice(0, 24).map(chunk => [
		`### Chunk ${chunk.index + 1}: ${chunk.heading}`,
		chunk.text,
	].join('\n')).join('\n\n');
	return [
		'Docling Markdown:',
		conversion.markdown.slice(0, 6000),
		'Docling Text:',
		conversion.text.slice(0, 6000),
		'Docling Chunks:',
		chunkText,
	].join('\n\n');
};

const extractedTextForResource = async (resource: ResourceEntity) => {
	const mime = resource.mime || '';
	if (mime === 'application/pdf' || resourceExtension(resource) === 'pdf') return await extractPdfText(resource);
	if (isZipOfficeResource(resource)) return await extractOfficeText(resource);
	if (isTextResource(resource)) return await extractPlainText(resource);
	return '';
};

const sourceTextForResource = async (resource: ResourceEntity): Promise<ResourceTextEntry> => {
	const docling = await convertDocumentWithDocling(resource);
	const extractedText = docling ? doclingTextForLlm(docling) : await extractedTextForResource(resource);
	return {
		llmText: [
			resource.title || '',
			resource.mime || resourceExtension(resource),
			resource.ocr_text || '',
			extractedText,
		].filter(Boolean).join('\n'),
		docling,
	};
};

const nativeRecordMediaAnalysis = () => NativeModules.RecordMediaAnalysis as NativeRecordMediaAnalysis | undefined;

const ocrImageNative = async (resource: ResourceEntity): Promise<string> => {
	const extractor = nativeRecordMediaAnalysis()?.extractImageText;
	if (!extractor) return '';
	try {
		return await extractor(Resource.fullPath(resource));
	} catch (error) {
		logger.warn('Failed to OCR image locally:', resource.id, error);
		return '';
	}
};

const ocrImageViaLlm = async (resource: ResourceEntity): Promise<string> => {
	try {
		const base64 = await shim.fsDriver().readFile(Resource.fullPath(resource), 'base64');
		const dataUrl = `data:${resource.mime || 'image/jpeg'};base64,${base64}`;
		return await callLlmTextWithFallback(
			'Extract all text from the image accurately. Return only the extracted text without markdown formatting.',
			[
				{ type: 'text', text: 'Extract all text from this image accurately.' },
				{ type: 'image_url', image_url: { url: dataUrl } },
			],
			0,
		);
	} catch (error) {
		logger.warn('Failed to OCR image via LLM:', error);
		return '';
	}
};

const asrAudioNative = async (resource: ResourceEntity): Promise<string> => {
	const extractor = nativeRecordMediaAnalysis()?.extractAudioText;
	if (!extractor) return '';
	try {
		return await extractor(Resource.fullPath(resource));
	} catch (error) {
		logger.warn('Failed to extract audio text:', error);
		return '';
	}
};

const nativeTimedTextSegments = async (extractor: ((path: string)=> Promise<unknown[]>) | undefined, path: string) => {
	if (!extractor) return [];
	try {
		return timedTextSegments(await extractor(path));
	} catch (error) {
		logger.warn('Failed to extract timed ASR segments:', error);
		return [];
	}
};

const asrAudioSegmentsNative = async (resource: ResourceEntity): Promise<RecordTimedTextSegment[]> => {
	return nativeTimedTextSegments(nativeRecordMediaAnalysis()?.extractAudioSegments, Resource.fullPath(resource));
};

const asrVideoAudioNative = async (resource: ResourceEntity): Promise<string> => {
	const extractor = nativeRecordMediaAnalysis()?.extractVideoAudioText;
	if (!extractor) return '';
	try {
		return await extractor(Resource.fullPath(resource));
	} catch (error) {
		logger.warn('Failed to extract video audio text:', error);
		return '';
	}
};

const asrVideoAudioSegmentsNative = async (resource: ResourceEntity): Promise<RecordTimedTextSegment[]> => {
	return nativeTimedTextSegments(nativeRecordMediaAnalysis()?.extractVideoAudioSegments, Resource.fullPath(resource));
};

const normalizedVideoFrame = (value: unknown, index: number): ExtractedVideoFrame | null => {
	if (typeof value === 'string') return { path: value, timestampMs: index * 1000 };
	const record = asRecord(value);
	const path = firstString(record?.path);
	if (!path) return null;
	return {
		path,
		timestampMs: typeof record?.timestampMs === 'number' ? record.timestampMs : index * 1000,
	};
};

const extractVideoFrames = async (resource: ResourceEntity) => {
	if (!(resource.mime || '').startsWith('video/')) return [];
	const extractor = nativeRecordMediaAnalysis()?.extractVideoFrames;
	if (!extractor) return [];
	const outputDir = `${shim.fsDriver().getAppDirectoryPath()}/3r-video-frames/${resource.id}`;
	try {
		if (await shim.fsDriver().exists(outputDir)) await shim.fsDriver().remove(outputDir);
		await shim.fsDriver().mkdir(outputDir);
		return (await extractor(Resource.fullPath(resource), outputDir, 6))
			.map(normalizedVideoFrame)
			.filter(Boolean) as ExtractedVideoFrame[];
	} catch (error) {
		logger.warn('Failed to extract video frames:', resource.id, error);
		return [];
	}
};

const frameDataUrls = async (frames: ExtractedVideoFrame[] | string[]) => {
	const output: string[] = [];
	for (const frame of frames.slice(0, 6)) {
		try {
			const path = typeof frame === 'string' ? frame : frame.path;
			const base64 = await shim.fsDriver().readFile(path, 'base64');
			output.push(`data:image/jpeg;base64,${base64}`);
		} catch (error) {
			logger.warn('Failed to read frame image:', frame, error);
		}
	}
	return output;
};

const describeVideoFramesViaLlm = async (resource: ResourceEntity, frames: ExtractedVideoFrame[]) => {
	if (!frames.length) return [];
	const frameUrls = await frameDataUrls(frames);
	if (!frameUrls.length) return [];
	const prompt = `请逐帧描述视频「${resource.title || resource.id}」抽帧画面。返回 JSON：{"frames":["第1帧描述", "..."]}，每帧一句，包含可见文字、主体、动作和学习线索。`;
	try {
		const content = await callLlmTextWithFallback(
			'You describe video frame images for a 3R Journal Reflect pipeline. Return compact JSON only.',
			[
				{ type: 'text', text: prompt },
				...frameUrls.map(imageUrl => ({ type: 'image_url' as const, image_url: { url: imageUrl } })),
			],
			0,
			500,
		);
		return stringArray(parseJsonObjectFromText(content)?.frames).slice(0, frames.length);
	} catch (error) {
		logger.warn('Failed to describe video frames via LLM:', error);
		return [];
	}
};

const reflectionToMarkdown = (payload: Omit<RecordReflectionPayload, 'markdown'>) => {
	const lines = [
		`# ${payload.title || '3R Reflect'}`,
		'',
		'## 文字提取总结',
		payload.textSummary,
		'',
		'## 关键点',
		...payload.keyPoints.map(point => `- ${point}`),
		'',
		'## 建议行动',
		...payload.recommendations.map(item => `- ${item}`),
		'',
		'## 标签分类',
		...payload.suggestedTags.map(tag => `- ${tag}`),
		'',
		'## 多模态记忆',
		`- 文字记忆: ${payload.textMemory.embedding.map(item => `${item.token}:${item.weight}`).join(', ')}`,
		...payload.imageMemories.map(item => `- 图片 ${item.title || item.id}: ${item.ocrText || item.visualMemory}`),
		...payload.audioTranscripts.flatMap(item => [
			`- 音频 ${item.title || item.id}: ${item.asrText || '等待 ASR 结果'}`,
			...item.asrSegments.slice(0, 8).map(segment => `  - ${formatTimestamp(segment.timestampMs)} ${segment.text}`),
		]),
		...payload.videoBreakdown.flatMap(item => [
			`- 视频 ${item.title || item.id}`,
			...item.frameSummaries.map(frame => `  - ${frame}`),
			...item.frameTextAlignments.map(alignment => `  - ${formatTimestamp(alignment.timestampMs)} 抽帧/ASR: ${alignment.frameSummary}${alignment.text ? ` | ${alignment.text}` : ''}`),
		]),
		...payload.documentMemories.flatMap(item => [
			`- 文档 ${item.title || item.id}: ${item.documentChunks?.length || 0} 个 Docling chunks`,
			...(item.documentChunks || []).slice(0, 4).map(chunk => `  - ${chunk.heading}: ${chunk.text.slice(0, 120)}`),
			item.documentMarkdownPath ? `  - Markdown: ${item.documentMarkdownPath}` : '',
			item.documentTextPath ? `  - Text: ${item.documentTextPath}` : '',
			item.documentChunkPath ? `  - Chunks: ${item.documentChunkPath}` : '',
		].filter(Boolean)),
		'',
		'## 关联组合关系',
		...payload.relations.map(item => `- ${item.from} -> ${item.to}: ${item.relation}`),
		'',
		'## 思维导图',
		...payload.mindMap.edges.map(edge => `- ${edge.from} --${edge.label}--> ${edge.to}`),
		'',
		`分析来源: ${payload.llmProvider === 'configured' ? 'LLM' : '本地提取'}`,
	];
	return lines.join('\n');
};

const makePdfObject = (id: number, content: string) => `${id} 0 obj\n${content}\nendobj\n`;

const utf16Hex = (text: string) => {
	const bytes: number[] = [0xfe, 0xff];
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		bytes.push((code >> 8) & 0xff, code & 0xff);
	}
	return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
};

const createSimplePdf = (title: string, text: string) => {
	const lines = [title, '', ...text.split('\n')].flatMap(line => {
		if (line.length <= 34) return [line];
		const wrapped = [];
		for (let i = 0; i < line.length; i += 34) wrapped.push(line.slice(i, i + 34));
		return wrapped;
	});
	const linesPerPage = 42;
	const pages: string[][] = [];
	for (let index = 0; index < lines.length; index += linesPerPage) {
		pages.push(lines.slice(index, index + linesPerPage));
	}
	if (!pages.length) pages.push([]);
	const fontObjectId = 3 + pages.length * 2;
	const descendantFontObjectId = fontObjectId + 1;
	const objects = [
		makePdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
		makePdfObject(2, `<< /Type /Pages /Kids [${pages.map((_page, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`),
	];
	for (const [index, pageLines] of pages.entries()) {
		const pageObjectId = 3 + index * 2;
		const contentObjectId = pageObjectId + 1;
		const stream = [
			'BT',
			'/F1 12 Tf',
			'50 790 Td',
			'18 TL',
			...pageLines.map(line => `<${utf16Hex(line)}> Tj T*`),
			'ET',
		].join('\n');
		objects.push(makePdfObject(pageObjectId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`));
		objects.push(makePdfObject(contentObjectId, `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`));
	}
	objects.push(makePdfObject(fontObjectId, `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${descendantFontObjectId} 0 R] >>`));
	objects.push(makePdfObject(descendantFontObjectId, '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>'));
	let offset = '%PDF-1.4\n'.length;
	const xref = ['0000000000 65535 f '];
	let body = '';
	for (const object of objects) {
		xref.push(`${offset.toString().padStart(10, '0')} 00000 n `);
		body += object;
		offset += Buffer.byteLength(object, 'utf8');
	}
	const xrefOffset = offset;
	const pdf = `%PDF-1.4\n${body}xref\n0 ${objects.length + 1}\n${xref.join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
	return Buffer.from(pdf, 'utf8').toString('base64');
};

const reviewNotificationId = (cardId: string) => {
	return parseInt(md5(cardId).slice(0, 8), 16) % 2147483647;
};

const materialJsonPrompt = (payload: RecordReflectionPayload) => [
	'请用费曼学习法，为这条 3R Journal 记录生成一份“生成式手帐风格”的演讲材料。',
	'要求返回 JSON，字段：title, slides, script。',
	'slides 是数组，每页包含 title, visualPrompt, bullets, speakerNotes。',
	'内容要像给初学者讲清楚：先用一句话解释，再用类比，再指出容易误解处，最后给一个小练习。',
	'视觉风格要有手绘便签、箭头、简笔图、关键词气泡、思维导图结构。',
	'Record summary:',
	payload.textSummary,
	'Key points:',
	payload.keyPoints.join('\n'),
	'Mind map:',
	payload.mindMap.edges.map(edge => `${edge.from} --${edge.label}--> ${edge.to}`).join('\n'),
	'Recommendations:',
	payload.recommendations.join('\n'),
].join('\n\n');

const localFeynmanSlides = (payload: RecordReflectionPayload): FeynmanSlide[] => {
	const title = payload.title || '3R 讲解';
	const firstPoint = payload.keyPoints[0] || payload.textSummary;
	const secondPoint = payload.keyPoints[1] || payload.recommendations[0] || payload.textSummary;
	const thirdPoint = payload.keyPoints[2] || payload.keywords.slice(0, 3).join('、') || payload.textSummary;
	return [
		{
			title: `${title} 是什么`,
			visualPrompt: '手帐封面：中心主题、大号关键词、三条彩色箭头、简笔图标。',
			bullets: [payload.textSummary, `一句话解释：${firstPoint}`, '先把复杂概念讲成生活里的普通动作。'],
			speakerNotes: `这一页先不要急着讲细节。用一句最普通的话解释：${firstPoint}`,
		},
		{
			title: '我怎么判断自己真的懂了',
			visualPrompt: '左右对比便签：左边是原始记录，右边是用自己的话复述。',
			bullets: [secondPoint, '把术语换成自己的话。', '如果讲不顺，就回到记录里找证据。'],
			speakerNotes: `这一页用费曼法检查理解：我能不能不用原文，清楚说出 ${secondPoint}`,
		},
		{
			title: '容易卡住的地方',
			visualPrompt: '手绘路障和放大镜，标出误区、例子、反例。',
			bullets: [thirdPoint, '找一个反例。', '把抽象点落到一个可执行动作。'],
			speakerNotes: `这一页要主动暴露薄弱点。围绕 ${thirdPoint} 讲一个例子，再讲一个反例。`,
		},
		{
			title: '下一步行动',
			visualPrompt: '行动清单手帐：三个 checkbox、一条时间线、一个复盘回环。',
			bullets: payload.recommendations.length ? payload.recommendations.slice(0, 4) : ['补充一个例子', '讲给别人听一次', '把卡住的问题写成新记录'],
			speakerNotes: '最后收束到行动：讲完以后立刻做一件能验证理解的小事。',
		},
	];
};

const normalizeFeynmanSlides = (value: unknown, payload: RecordReflectionPayload): FeynmanSlide[] => {
	const fallback = localFeynmanSlides(payload);
	if (!Array.isArray(value)) return fallback;
	const slides = value.map((slideValue, index) => {
		const slide = asRecord(slideValue);
		return {
			title: firstString(slide?.title, fallback[index]?.title, `Slide ${index + 1}`),
			visualPrompt: firstString(slide?.visualPrompt, fallback[index]?.visualPrompt),
			bullets: stringArray(slide?.bullets).slice(0, 6),
			speakerNotes: firstString(slide?.speakerNotes, fallback[index]?.speakerNotes),
		};
	}).filter(slide => slide.title && slide.speakerNotes);
	return slides.length ? slides : fallback;
};

const feynmanMaterialMarkdown = (payload: RecordReflectionPayload, title: string, slides: FeynmanSlide[]) => {
	const imageLines = payload.imageMemories.slice(0, 4).flatMap(memory => memory.resourcePath ? [
		`![${memory.title}](${memory.resourcePath})`,
		`图文对应：${memory.ocrText || memory.textMemory.join('、') || memory.visualMemory}`,
	] : []);
	const frameLines = payload.videoBreakdown.flatMap(memory => (memory.frameImagePaths || []).slice(0, 4).map((path, index) => `![${memory.title} 抽帧 ${index + 1}](${path})`));
	const mindMapLines = payload.mindMap.edges.map(edge => `- ${edge.from} --${edge.label}--> ${edge.to}`);
	return [
		`# ${title}`,
		'',
		'## 生成式手帐视觉素材',
		...imageLines,
		...frameLines,
		'',
		'## 思维导图结构',
		...mindMapLines,
		'',
		'## 演讲 PPT 大纲',
		...slides.flatMap((slide, index) => [
			`### ${index + 1}. ${slide.title}`,
			'',
			`视觉生成提示：${slide.visualPrompt}`,
			'',
			...slide.bullets.map(item => `- ${item}`),
			'',
			`讲解词：${slide.speakerNotes}`,
			'',
		]),
		'## 费曼法自测',
		'- 我能不能用一句话讲清楚？',
		'- 我能不能举一个生活类比？',
		'- 我能不能指出一个反例或误区？',
		'- 我能不能给听众一个小练习？',
	].join('\n');
};

const feynmanScriptMarkdown = (title: string, slides: FeynmanSlide[]) => [
	`# ${title} 讲解词`,
	'',
	...slides.flatMap((slide, index) => [
		`## ${index + 1}. ${slide.title}`,
		slide.speakerNotes,
		'',
	]),
].join('\n');

const persistent3RDir = async () => {
	const dir = `${shim.fsDriver().getAppDirectoryPath()}/3r-records`;
	await shim.fsDriver().mkdir(dir);
	return dir;
};

const writeTextToPersistentFile = async (text: string, fileName: string) => {
	const dir = await persistent3RDir();
	const filePath = `${dir}/${fileName}`;
	await shim.fsDriver().writeFile(filePath, text, 'utf8');
	return filePath;
};

const feynmanJsonPath = async (recordId: string) => `${await persistent3RDir()}/3r-feynman-${recordId}.json`;

const keywordFlashcardBack = (payload: RecordReflectionPayload, keyword: string) => {
	const matchingRelations = payload.relations
		.filter(item => item.from === keyword || item.to === keyword)
		.map(item => `${item.from} - ${item.relation} - ${item.to}`)
		.slice(0, 3);
	const matchingKeyPoints = payload.keyPoints
		.filter(point => point.toLowerCase().includes(keyword.toLowerCase()))
		.slice(0, 2);
	const memories = payload.imageMemories
		.concat(payload.audioTranscripts, payload.videoBreakdown, payload.documentMemories)
		.filter(memory => memory.title.toLowerCase().includes(keyword.toLowerCase()) || memory.textMemory.some(token => token.toLowerCase() === keyword.toLowerCase()))
		.map(memory => memory.title)
		.slice(0, 3);
	return [
		matchingRelations.length ? `关系链：${matchingRelations.join('；')}` : `核心含义：${keyword} 是这条记录中的主题线索。`,
		matchingKeyPoints.length ? `关键证据：${matchingKeyPoints.join('；')}` : `总结依据：${payload.textSummary}`,
		memories.length ? `相关素材：${memories.join('、')}` : '',
		`复述练习：用自己的话说明「${keyword}」怎样连接记录内容、证据和下一步行动。`,
	].filter(Boolean).join('\n');
};

export default class RecordAnalysisService {
	private static backgroundRunning_ = false;
	private static activeRecordIds_ = new Set<string>();
	private static llmVerification_: { key: string; ok: boolean; checkedAt: number } | null = null;

	private static llmConfig(): LlmConfig {
		return llmConfigFromSettings('primary');
	}

	private static llmVerificationKey(config: LlmConfig) {
		return md5(`${config.provider}:${llmEndpointUrl(config.baseUrl)}:${config.model}:${config.apiKey.slice(0, 8)}:${config.apiKey.slice(-8)}`);
	}

	public static llmConfigured(): boolean {
		return configuredLlmConfigsFromSettings().length > 0;
	}

	public static defaultReflectPrompt(): string {
		return defaultReflectPrompt;
	}

	public static async fetchOpenRouterModels(): Promise<LlmModelOption[]> {
		const apiKey = llmConfigsFromSettings().find(config => config.provider === 'openrouter' && config.apiKey)?.apiKey || '';
		const response = await fetch(openRouterModelsUrl, apiKey ? { headers: { 'Authorization': `Bearer ${apiKey}` } } : undefined);
		const responseText = await response.text();
		if (!response.ok) throw new Error(`OpenRouter models request failed: ${response.status} ${responseText}`);
		const root = asRecord(JSON.parse(responseText));
		const data = root?.data;
		if (!Array.isArray(data)) return [];
		return data
			.map(openRouterModelFromJson)
			.filter(Boolean)
			.sort((a, b) => {
				if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
				return a.name.localeCompare(b.name);
			}) as LlmModelOption[];
	}

	public static async verifyLlmConfiguration(force = false): Promise<boolean> {
		for (const config of configuredLlmConfigsFromSettings()) {
			const url = llmEndpointUrl(config.baseUrl);
			const usesResponses = isResponsesEndpoint(url);
			const key = this.llmVerificationKey(config);
			if (!force && this.llmVerification_?.key === key && Date.now() - this.llmVerification_.checkedAt < 15 * 60 * 1000) {
				if (this.llmVerification_.ok) return true;
				continue;
			}

			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: llmRequestHeaders(config),
					body: JSON.stringify(usesResponses ? {
						model: config.model,
						instructions: 'Return ok.',
						input: 'ok',
						max_output_tokens: 16,
					} : {
						model: config.model,
						messages: [
							{ role: 'system', content: 'Return ok.' },
							{ role: 'user', content: 'ok' },
						],
						...chatCompletionOptions(config, 0, 4),
					}),
				});
				const ok = response.ok && response.status < 400;
				this.llmVerification_ = { key, ok, checkedAt: Date.now() };
				if (ok) return true;
				logger.warn('3R LLM verification failed:', url, response.status, await response.text());
			} catch (error) {
				this.llmVerification_ = { key, ok: false, checkedAt: Date.now() };
				logger.warn('3R LLM verification failed:', url, error);
			}
		}
		return false;
	}

	public static async checkLlmConfigurationPrompt(): Promise<string> {
		const configs = llmConfigsFromSettings();
		const configuredCount = configs.filter(config => config.apiKey && config.baseUrl && config.model).length;
		if (!configuredCount) {
			throw new Error('LLM API key, URL, and model must be configured first.');
		}

		const blocks: string[] = [];
		const errors: string[] = [];
		for (const config of configs) {
			if (!config.apiKey || !config.baseUrl || !config.model) {
				blocks.push(`${config.label}: 未配置完整，已跳过。`);
				continue;
			}
			const url = llmEndpointUrl(config.baseUrl);
			const usesResponses = isResponsesEndpoint(url);
			const startedAt = Date.now();
			const response = await fetch(url, {
				method: 'POST',
				headers: llmRequestHeaders(config),
				body: JSON.stringify(usesResponses ? {
					model: config.model,
					instructions: 'You are a configuration checker for a 3R Journal app. Answer in compact Chinese.',
					input: `请确认当前 LLM 配置是否可用。请说明：1. 配置槽位是 ${config.label}; 2. 配置的模型名是 ${config.model}; 3. 你可以为 3R Journal 做哪些能力，包括 Reflect 拆解组合分析和 Refine 闪卡建议。`,
					max_output_tokens: 220,
				} : {
					model: config.model,
					messages: [
						{
							role: 'system',
							content: 'You are a configuration checker for a 3R Journal app. Answer in compact Chinese.',
						},
						{
							role: 'user',
							content: `请确认当前 LLM 配置是否可用。请说明：1. 配置槽位是 ${config.label}; 2. 配置的模型名是 ${config.model}; 3. 你可以为 3R Journal 做哪些能力，包括 Reflect 拆解组合分析和 Refine 闪卡建议。`,
						},
					],
					...chatCompletionOptions(config, 0, 220),
				}),
			});
			const elapsedMs = Date.now() - startedAt;
			const responseText = await response.text();
			let responseJson: unknown = null;
			try {
				responseJson = JSON.parse(responseText);
			} catch (error) {
				logger.warn('Failed to parse LLM check response:', error);
			}
			const responseRoot = asRecord(responseJson);
			const usage = asRecord(responseRoot?.usage);
			const logLines = [
				`Slot: ${config.label}`,
				`Provider: ${llmProviderLabel(config.provider)}`,
				`Endpoint: ${url}`,
				`Model: ${config.model}`,
				`API key: ${maskedApiKey(config.apiKey)}`,
				`Endpoint mode: ${usesResponses ? 'Responses API' : 'Chat Completions API'}`,
				`HTTP status: ${response.status} ${response.statusText}`,
				`Duration: ${elapsedMs} ms`,
				firstString(responseRoot?.id) ? `Response id: ${firstString(responseRoot?.id)}` : '',
				firstString(responseRoot?.model) ? `Response model: ${firstString(responseRoot?.model)}` : '',
				usage ? `Usage: prompt=${usage.prompt_tokens ?? 'n/a'}, completion=${usage.completion_tokens ?? usage.output_tokens ?? 'n/a'}, total=${usage.total_tokens ?? 'n/a'}` : '',
			].filter(Boolean);
			if (!response.ok) {
				errors.push(`${config.label} failed.\n${logLines.join('\n')}\nResponse body: ${responseText}`);
				blocks.push(`${config.label}: 检查失败。\n${logLines.join('\n')}`);
				continue;
			}
			const content = usesResponses ? responseAssistantContent(responseJson) : chatAssistantContent(responseJson);
			blocks.push([
				`${config.label}: 检查通过。`,
				content || `LLM 配置可用。模型：${config.model}`,
				'',
				'LLM check logs',
				...logLines,
			].join('\n'));
		}

		await this.verifyLlmConfiguration(true);
		if (errors.length === configuredCount) throw new Error(`LLM prompt check failed.\n\n${errors.join('\n\n')}`);
		return blocks.join('\n\n---\n\n');
	}

	public static async generateOpenAiImage(prompt: string): Promise<GeneratedRecordMedia> {
		const config = configuredLlmConfigForProvider('openai');
		if (!config?.apiKey) throw new Error('请先在 3R LLM 配置中添加 OpenAI API key。');
		const response = await fetch(openAiImageGenerationsUrl, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${config.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: openAiImageModel,
				prompt,
				size: '1024x1024',
				quality: 'low',
				output_format: 'png',
				n: 1,
			}),
		});
		const responseText = await response.text();
		if (!response.ok) throw new Error(`OpenAI image generation failed: ${response.status} ${responseText}`);
		const root = asRecord(JSON.parse(responseText));
		const data = root?.data;
		const item = Array.isArray(data) ? asRecord(data[0]) : null;
		const fileName = `3r-ai-image-${Date.now()}.png`;
		const b64Json = firstString(item?.b64_json);
		if (b64Json) {
			return {
				uri: await writeBase64MediaToCache(b64Json, fileName),
				fileName,
				type: 'image/png',
			};
		}
		const url = firstString(item?.url);
		if (!url) throw new Error('OpenAI image generation response did not include image data.');
		const filePath = `${shim.fsDriver().getCacheDirectoryPath()}/${fileName}`;
		const downloadResponse = await shim.fetchBlob(url, { path: filePath, maxRetry: 1 });
		if (!downloadResponse.ok) throw new Error(`OpenAI image download failed: ${downloadResponse.status}`);
		return { uri: filePath, fileName, type: 'image/png' };
	}

	public static async generateGoogleVeoVideo(prompt: string, image?: { uri: string; type?: string }): Promise<GeneratedRecordMedia> {
		const config = configuredLlmConfigForProvider('google');
		if (!config?.apiKey) throw new Error('请先在 3R LLM 配置中添加 Google Gemini API key。');
		const instance: Record<string, unknown> = { prompt };
		if (image?.uri) {
			instance.image = {
				imageBytes: await shim.fsDriver().readFile(normalizeLocalFilePath(image.uri), 'base64'),
				mimeType: image.type || 'image/png',
			};
		}
		const response = await fetch(`${geminiApiBaseUrl}/models/${googleVeoModel}:predictLongRunning`, {
			method: 'POST',
			headers: {
				'x-goog-api-key': config.apiKey,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				instances: [instance],
				parameters: {
					aspectRatio: '9:16',
					durationSeconds: 8,
					resolution: '720p',
				},
			}),
		});
		const responseText = await response.text();
		if (!response.ok) throw new Error(`Google Veo generation failed: ${response.status} ${responseText}`);
		let operation = asRecord(JSON.parse(responseText));
		const operationName = firstString(operation?.name);
		if (!operationName) throw new Error('Google Veo response did not include an operation name.');
		for (let attempt = 0; attempt < 36; attempt++) {
			await sleep(10000);
			const statusResponse = await fetch(`${geminiApiBaseUrl}/${operationName}`, {
				headers: { 'x-goog-api-key': config.apiKey },
			});
			const statusText = await statusResponse.text();
			if (!statusResponse.ok) throw new Error(`Google Veo status check failed: ${statusResponse.status} ${statusText}`);
			operation = asRecord(JSON.parse(statusText));
			if (operation?.done) {
				const fileName = `3r-ai-video-${Date.now()}.mp4`;
				const videoBase64 = firstGeneratedVideoBase64(operation);
				if (videoBase64) {
					return {
						uri: await writeBase64MediaToCache(videoBase64, fileName),
						fileName,
						type: 'video/mp4',
					};
				}
				const videoUri = firstGeneratedVideoUri(operation);
				if (!videoUri) throw new Error(`Google Veo completed without a video URI: ${JSON.stringify(operation)}`);
				const filePath = `${shim.fsDriver().getCacheDirectoryPath()}/${fileName}`;
				const downloadResponse = await shim.fetchBlob(videoUri, {
					path: filePath,
					maxRetry: 1,
					headers: { 'x-goog-api-key': config.apiKey },
				});
				if (!downloadResponse.ok) throw new Error(`Google Veo video download failed: ${downloadResponse.status}`);
				return { uri: filePath, fileName, type: 'video/mp4' };
			}
		}
		throw new Error('Google Veo generation timed out before the video was ready.');
	}

	private static async callReflectLlm(options: { title: string; recordText: string; resourceTexts: string; tags: string[]; entryType: string; frameImageDataUrls: string[]; reflectPrompt?: string }): Promise<LlmReflectResult | null> {
		const userText = [
			`Title: ${options.title}`,
			`Entry type: ${options.entryType}`,
			`Tags: ${options.tags.join(', ')}`,
			'Record:',
			options.recordText,
			'Multimodal OCR/ASR/document/video frame text:',
			options.resourceTexts,
		].join('\n');
		const userContent: string | LlmMessagePart[] = options.frameImageDataUrls.length ? [
			{ type: 'text', text: userText },
			...options.frameImageDataUrls.map(url => ({ type: 'image_url' as const, image_url: { url } })),
		] : userText;
		const messages: LlmMessage[] = [
			{
				role: 'system',
				content: options.reflectPrompt || defaultReflectPrompt,
			},
			{
				role: 'user',
				content: userContent,
			},
		];

		try {
			const content = await callLlmTextWithFallback(messages[0].content as string, userContent, 0.2);
			const parsed = parseJsonObjectFromText(content);
			if (!parsed) return null;

			const textSummary = firstString(parsed.textSummary, parsed.summary);
			return {
				textSummary,
				keyPoints: stringArray(parsed.keyPoints),
				recommendations: stringArray(parsed.recommendations),
				suggestedTags: stringArray(parsed.suggestedTags),
			};
		} catch (error) {
			logger.warn('Reflect LLM failed, using local fallback:', error);
			return null;
		}
	}

	private static async loadRecord(recordId: string): Promise<RecordWithNote> {
		const record = await RecordService.getRecord(recordId);
		if (!record) throw new Error(`Record not found: ${recordId}`);
		return record;
	}

	private static async saveNoteSection(note: NoteEntity, section: 'Reflect' | 'Refine', content: string): Promise<void> {
		await Note.save({
			id: note.id,
			body: replaceMarkdownSection(note.body || '', section, content),
		} as NoteEntity);
	}

	private static async loadResources(note: NoteEntity): Promise<ResourceEntity[]> {
		const resourceIds = await Note.linkedResourceIds(note.body || '');
		const resources: ResourceEntity[] = [];
		for (const resourceId of resourceIds) {
			const resource = await Resource.load(resourceId);
			if (resource) resources.push(resource);
		}
		return resources;
	}

	public static async analyzeRecord(recordId: string, options: AnalyzeOptions = {}): Promise<RecordReflectionPayload> {
		const { record, note, tags } = await this.loadRecord(recordId);
		const resources = await this.loadResources(note);
		const asrSegmentsById = new Map<string, RecordTimedTextSegment[]>();
		const ocrAsrTexts = await Promise.all(resources.map(async resource => {
			if (resource.ocr_text) return resource.ocr_text;
			const type = resourceType(resource.mime || '');
			if (type === 'image') return await ocrImageNative(resource) || await ocrImageViaLlm(resource);
			if (type === 'audio') {
				const segments = await asrAudioSegmentsNative(resource);
				asrSegmentsById.set(resource.id, segments);
				return speechSegmentsToText(segments) || await asrAudioNative(resource);
			}
			if (type === 'video') {
				const segments = await asrVideoAudioSegmentsNative(resource);
				asrSegmentsById.set(resource.id, segments);
				return speechSegmentsToText(segments) || await asrVideoAudioNative(resource);
			}
			return '';
		}));
		const resourceSourceEntries = await Promise.all(resources.map(sourceTextForResource));
		for (let index = 0; index < resources.length; index++) {
			const resource = resources[index];
			const extractedText = ocrAsrTexts[index] || resourceSourceEntries[index].docling?.text || '';
			if (extractedText && !resource.ocr_text) {
				await Resource.save({
					id: resource.id,
					ocr_text: extractedText.slice(0, 120000),
					ocr_status: ResourceOcrStatus.Done,
					ocr_error: '',
				});
			}
		}
		const resourceTextEntries = resourceSourceEntries.map((entry, index) => {
			const ocrAsrText = ocrAsrTexts[index];
			const resource = resources[index];
			return ocrAsrText && !resource.ocr_text ? [entry.llmText, ocrAsrText].join('\n') : entry.llmText;
		});
		const resourceTextById = new Map<string, string>();
		const resourceDoclingById = new Map<string, DoclingDocumentConversion>();
		resources.forEach((resource, index) => {
			resourceTextById.set(resource.id, resourceTextEntries[index]);
			const docling = resourceSourceEntries[index].docling;
			if (docling) resourceDoclingById.set(resource.id, docling);
		});
		const videoFramesById = new Map<string, ExtractedVideoFrame[]>();
		for (const resource of resources) {
			videoFramesById.set(resource.id, await extractVideoFrames(resource));
		}
		const videoFrameDescriptionsById = new Map<string, string[]>();
		const frameTextAlignmentsById = new Map<string, RecordFrameTextAlignment[]>();
		for (const resource of resources) {
			const frames = videoFramesById.get(resource.id) || [];
			if (frames.length) {
				const descriptions = await describeVideoFramesViaLlm(resource, frames);
				videoFrameDescriptionsById.set(resource.id, descriptions);
				frameTextAlignmentsById.set(resource.id, alignFramesWithSpeech(frames, descriptions, asrSegmentsById.get(resource.id) || []));
			}
		}
		const frameImageDataUrls = await frameDataUrls(Array.from(videoFramesById.values()).flat());
		const resourceTexts = resources.map((resource, index) => {
			const alignments = frameTextAlignmentsById.get(resource.id) || [];
			const alignmentText = alignments.map(item => [
				`Frame ${formatTimestamp(item.timestampMs)}: ${item.frameSummary}`,
				item.text ? `ASR ${formatTimestamp(item.timestampMs)}: ${item.text}` : '',
			].filter(Boolean).join('\n')).join('\n');
			return [resourceTextEntries[index], alignmentText].filter(Boolean).join('\n');
		}).join('\n');
		const recordText = markdownSection(note.body || '', 'Record') || note.body || '';
		const sourceText = [note.title || '', recordText, record.source_url || '', tags.join(' '), resourceTexts].join('\n');
		const sourceHash = md5(sourceText);
		const localSummary = summarize(`${recordText}\n${resourceTexts}`, note.title || '');
		const llmResult = await this.callReflectLlm({
			title: note.title || '',
			recordText,
			resourceTexts,
			tags,
			entryType: record.entry_type,
			frameImageDataUrls,
			reflectPrompt: options.reflectPrompt,
		});
		if (options.requireConfiguredLlm && !llmResult) {
			throw new Error('3R Reflect requires a verified LLM configuration, but the LLM request failed.');
		}
		const summary = llmResult?.textSummary || localSummary;
		const keywords = topKeywords(sourceText, 12);
		const keywordTokens = keywords.map(item => item.token);
		const localKeyPoints = splitSentences(`${summary}\n${resourceTexts}`).slice(0, 6);
		const keyPoints = (llmResult?.keyPoints.length ? llmResult.keyPoints : localKeyPoints).slice(0, 8);
		const recommendations = (llmResult?.recommendations.length ? llmResult.recommendations : keyPoints.slice(0, 3).map(point => `下一步围绕「${point.slice(0, 24)}」补充行动或证据。`)).slice(0, 6);
		const memories = resources.map((resource, index) => {
			const type = resourceType(resource.mime || '');
			const resourceText = resourceTextById.get(resource.id) || '';
			const frames = videoFramesById.get(resource.id) || [];
			const ocrAsrText = ocrAsrTexts[index];
			const docling = resourceDoclingById.get(resource.id);
			return {
				id: resource.id,
				title: resource.title || resource.id,
				mime: resource.mime || '',
				type,
				resourcePath: Resource.fullPath(resource),
				ocrText: type === 'image' || type === 'file' ? ocrAsrText : '',
				asrText: type === 'audio' || type === 'video' ? ocrAsrText : '',
				asrSegments: asrSegmentsById.get(resource.id) || [],
				visualMemory: `${resource.id}:${md5(`${resource.id}:${resource.title}:${resource.mime}`).slice(0, 12)}`,
				textMemory: topKeywords(resourceText, 6).map(item => item.token),
				frameSummaries: makeFrameSummaries(resource, frames, videoFrameDescriptionsById.get(resource.id) || []),
				frameImagePaths: frames.map(frame => frame.path),
				frameTimestampsMs: frames.map(frame => frame.timestampMs),
				frameTextAlignments: frameTextAlignmentsById.get(resource.id) || [],
				documentMarkdown: docling?.markdown.slice(0, 8000) || '',
				documentMarkdownPath: docling?.markdownPath || '',
				documentTextPath: docling?.textPath || '',
				documentChunkPath: docling?.chunkPath || '',
				documentChunks: docling?.chunks.slice(0, 24) || [],
			};
		});
		const suggestedTags = Array.from(new Set(tags.concat(llmResult?.suggestedTags || [], keywordTokens.slice(0, 6), record.entry_type))).slice(0, 10);
		const keywordRelationItems = keywordRelations(keywordTokens, keyPoints);
		const nodes: MindMapNode[] = [
			{ id: 'record', label: note.title || '记录', kind: 'record' },
			...keywordTokens.slice(0, 6).map(token => ({ id: `topic:${token}`, label: token, kind: 'topic' as const })),
			...memories.slice(0, 6).map(memory => ({ id: `resource:${memory.id}`, label: memory.title, kind: 'resource' as const })),
			...keyPoints.slice(0, 3).map((point, index) => ({ id: `action:${index}`, label: point.slice(0, 24), kind: 'action' as const })),
		];
		const edges: MindMapEdge[] = nodes
			.filter(node => node.id !== 'record')
			.map(node => ({ from: 'record', to: node.id, label: node.kind === 'resource' ? '包含' : '提炼' }))
			.concat(keywordRelationItems.map(item => ({ from: `topic:${item.from}`, to: `topic:${item.to}`, label: item.relation })));
		const relations = memories.map(memory => ({
			from: note.title || record.id,
			to: memory.title,
			relation: memory.type === 'image' ? '图文双编码' : memory.type === 'audio' ? 'ASR转写关联' : memory.type === 'video' ? '抽帧摘要关联' : '附件上下文关联',
		})).concat(keywordTokens.slice(0, 6).map(token => ({
			from: note.title || record.id,
			to: token,
			relation: '主题词',
		})), keywordRelationItems);
		const payloadWithoutMarkdown: Omit<RecordReflectionPayload, 'markdown'> = {
			recordId: record.id,
			noteId: note.id,
			title: note.title || '3R Reflect',
			generatedAt: Date.now(),
			sourceHash,
			textSummary: summary,
			keyPoints,
			recommendations,
			keywords: keywordTokens,
			suggestedTags,
			llmProvider: llmResult ? 'configured' : 'local-fallback',
			textMemory: {
				embedding: keywords,
				summary,
			},
			imageMemories: memories.filter(memory => memory.type === 'image'),
			audioTranscripts: memories.filter(memory => memory.type === 'audio'),
			videoBreakdown: memories.filter(memory => memory.type === 'video'),
			documentMemories: memories.filter(memory => memory.type === 'file' && !!memory.documentMarkdownPath),
			relations,
			mindMap: { nodes, edges },
		};
		const markdown = reflectionToMarkdown(payloadWithoutMarkdown);
		const payload: RecordReflectionPayload = { ...payloadWithoutMarkdown, markdown };
		const markdownPath = await writeTextToPersistentFile(markdown, `3r-reflect-${record.id}.md`);
		const now = Date.now();
		const reflection: RecordReflection = {
			id: uuid.create(),
			record_id: record.id,
			note_id: note.id,
			source_hash: sourceHash,
			payload: JSON.stringify(payload),
			markdown_path: markdownPath,
			created_time: now,
			updated_time: now,
		};
		await RecordDatabase.upsertReflection(reflection);
		await this.saveNoteSection(note, 'Reflect', markdown);
		await RecordService.updateRecord(record.id, { tags: suggestedTags });
		return payload;
	}

	public static async loadReflection(recordId: string): Promise<RecordReflectionPayload | null> {
		const row = await RecordDatabase.latestReflection(recordId);
		if (!row) return null;
		const payload = normalizeReflectionPayload(JSON.parse(row.payload), recordId);
		return await this.ensureVideoFramesAvailable(recordId, payload);
	}

	private static async ensureVideoFramesAvailable(recordId: string, payload: RecordReflectionPayload): Promise<RecordReflectionPayload> {
		let changed = false;
		const videoBreakdown = [];
		for (const memory of payload.videoBreakdown) {
			const hasReadableFrame = await Promise.all((memory.frameImagePaths || []).map(async path => path ? await shim.fsDriver().exists(path) : false));
			if (hasReadableFrame.some(Boolean)) {
				videoBreakdown.push(memory);
				continue;
			}
			const resource = memory.id ? await Resource.load(memory.id) : null;
			if (!resource) {
				videoBreakdown.push(memory);
				continue;
			}
			const frames = await extractVideoFrames(resource);
			if (!frames.length) {
				videoBreakdown.push(memory);
				continue;
			}
			changed = true;
			const frameSummaries = makeFrameSummaries(resource, frames, memory.frameSummaries);
			videoBreakdown.push({
				...memory,
				frameImagePaths: frames.map(frame => frame.path),
				frameTimestampsMs: frames.map(frame => frame.timestampMs),
				frameSummaries,
				frameTextAlignments: memory.frameTextAlignments.map((alignment, index) => ({
					...alignment,
					framePath: frames[index]?.path || alignment.framePath,
				})),
			});
		}
		if (!changed) return payload;
		const nextPayload = {
			...payload,
			videoBreakdown,
		};
		const recordWithNote = await this.loadRecord(recordId);
		await this.persistReflectionPayload(recordWithNote, {
			...nextPayload,
			markdown: payload.markdown,
		});
		return {
			...nextPayload,
			markdown: payload.markdown,
		};
	}

	private static async persistReflectionPayload(recordWithNote: RecordWithNote, payload: RecordReflectionPayload): Promise<void> {
		const markdownPath = await writeTextToPersistentFile(payload.markdown, `3r-reflect-${recordWithNote.record.id}.md`);
		const now = Date.now();
		await RecordDatabase.upsertReflection({
			id: uuid.create(),
			record_id: recordWithNote.record.id,
			note_id: recordWithNote.note.id,
			source_hash: payload.sourceHash || md5(payload.markdown),
			payload: JSON.stringify(payload),
			markdown_path: markdownPath,
			created_time: now,
			updated_time: now,
		});
		await this.saveNoteSection(recordWithNote.note, 'Reflect', payload.markdown);
	}

	public static async saveEditedReflection(recordId: string, markdown: string): Promise<RecordReflectionPayload> {
		const recordWithNote = await this.loadRecord(recordId);
		const existing = await this.loadReflection(recordId) ?? await this.analyzeRecord(recordId);
		const editedSentences = splitSentences(stripMarkdownResources(markdown));
		const textSummary = markdownHeadingContent(markdown, '文字提取总结') || editedSentences.slice(0, 4).join('\n') || existing.textSummary;
		const keyPoints = markdownListItems(markdown, '关键点');
		const nextKeyPoints = keyPoints.length ? keyPoints : editedSentences.slice(0, 6);
		const recommendations = markdownListItems(markdown, '建议行动');
		const nextRecommendations = recommendations.length ? recommendations : editedSentences.slice(0, 3).map(point => `下一步围绕「${point.slice(0, 24)}」补充行动或证据。`);
		const suggestedTags = markdownListItems(markdown, '标签分类');
		const keywords = topKeywords(markdown, 12).map(item => item.token);
		const keywordRelationItems = keywordRelations(keywords, nextKeyPoints.length ? nextKeyPoints : existing.keyPoints);
		const nodes: MindMapNode[] = [
			{ id: 'record', label: existing.title || recordWithNote.note.title || '记录', kind: 'record' },
			...keywords.slice(0, 6).map(token => ({ id: `topic:${token}`, label: token, kind: 'topic' as const })),
			...existing.imageMemories.concat(existing.audioTranscripts, existing.videoBreakdown, existing.documentMemories).slice(0, 6).map(memory => ({ id: `resource:${memory.id}`, label: memory.title, kind: 'resource' as const })),
			...(nextKeyPoints.length ? nextKeyPoints : existing.keyPoints).slice(0, 3).map((point, index) => ({ id: `action:${index}`, label: point.slice(0, 24), kind: 'action' as const })),
		];
		const mindMap = {
			nodes,
			edges: nodes
				.filter(node => node.id !== 'record')
				.map(node => ({ from: 'record', to: node.id, label: node.kind === 'resource' ? '包含' : '提炼' }))
				.concat(keywordRelationItems.map(item => ({ from: `topic:${item.from}`, to: `topic:${item.to}`, label: item.relation }))),
		};
		const nextPayload: RecordReflectionPayload = {
			...existing,
			generatedAt: Date.now(),
			sourceHash: md5(markdown),
			textSummary,
			keyPoints: nextKeyPoints.length ? nextKeyPoints : existing.keyPoints,
			recommendations: nextRecommendations.length ? nextRecommendations : existing.recommendations,
			keywords,
			suggestedTags: suggestedTags.length ? suggestedTags : existing.suggestedTags,
			textMemory: {
				embedding: topKeywords(markdown, 12),
				summary: textSummary,
			},
			relations: existing.relations.concat(keywordRelationItems).slice(0, 24),
			mindMap,
			markdown,
		};
		await this.persistReflectionPayload(recordWithNote, nextPayload);
		return nextPayload;
	}

	public static async generateFlashcards(recordId: string): Promise<RecordFlashcard[]> {
		let reflection = await RecordDatabase.latestReflection(recordId);
		if (!reflection) {
			await this.analyzeRecord(recordId);
			reflection = await RecordDatabase.latestReflection(recordId);
		}
		if (!reflection) throw new Error(`No reflection generated for record: ${recordId}`);
		const payload = normalizeReflectionPayload(JSON.parse(reflection.payload), recordId);
		const now = Date.now();
		const prompts = [
			...payload.keyPoints.slice(0, 4).map((point, index) => ({
				front: `这条记录的关键点 ${index + 1} 是什么？`,
				back: point,
				sourceKey: `key:${index}`,
			})),
			...payload.keywords.slice(0, 4).map(keyword => ({
				front: `主题词「${keyword}」在这条记录里关联了什么？`,
				back: keywordFlashcardBack(payload, keyword),
				sourceKey: `keyword:${keyword}`,
			})),
			...payload.imageMemories.slice(0, 2).map(memory => ({
				front: `图片「${memory.title}」提取出了哪些内容？`,
				back: memory.ocrText || memory.textMemory.join(', ') || memory.visualMemory,
				sourceKey: `image:${memory.id}`,
			})),
			...payload.audioTranscripts.concat(payload.videoBreakdown).slice(0, 2).map(memory => ({
				front: `媒体「${memory.title}」的转写/拆解摘要是什么？`,
				back: memory.asrText || memory.frameSummaries.join('\n') || '等待 OCR/ASR 结果后复盘。',
				sourceKey: `media:${memory.id}`,
			})),
		].filter(item => item.back.trim().length > 0);
		const cards = prompts.slice(0, 10).map((prompt, index) => ({
			id: uuid.create(),
			record_id: recordId,
			reflection_id: reflection.id,
			front: prompt.front,
			back: prompt.back,
			source_key: prompt.sourceKey,
			position_x: 16 + (index % 2) * 148,
			position_y: 16 + Math.floor(index / 2) * 132,
			group_key: payload.keywords[index % Math.max(1, payload.keywords.length)] || 'default',
			due_time: now + (index === 0 ? 0 : 24 * 60 * 60 * 1000),
			interval_days: 1,
			ease_factor: 2.5,
			review_count: 0,
			created_time: now,
			updated_time: now,
			is_deleted: 0,
		}));
		await RecordDatabase.replaceFlashcards(recordId, cards);
		for (const card of cards.slice(0, 3)) {
			await this.scheduleFlashcardReminder(card);
		}
		const recordWithNote = await this.loadRecord(recordId);
		const existingRefine = markdownSection(recordWithNote.note.body || '', 'Refine');
		const existingFeynmanSection = markdownSubsection(existingRefine, 'Feynman Technique') || markdownSubsection(existingRefine, '费曼 Technique') || markdownSubsection(existingRefine, '费曼讲解材料');
		await this.saveNoteSection(recordWithNote.note, 'Refine', [
			'## 精进建议',
			...(payload.recommendations.length ? payload.recommendations.map(item => `- ${item}`) : ['- 暂无建议，先生成 Reflect 复盘。']),
			'',
			'## 复盘闪卡',
			...cards.map((card, index) => `${index + 1}. ${card.front}\n答案: ${card.back}\n组合: ${card.group_key}`),
			'',
			'## 闪卡提醒',
			...cards.slice(0, 3).map(card => `- ${card.front}：${new Date(card.due_time).toLocaleString()}`),
			existingFeynmanSection ? `\n${existingFeynmanSection}` : '',
		].join('\n\n'));
		return cards;
	}

	public static async generateFeynmanTeachingMaterial(recordId: string): Promise<FeynmanTeachingMaterial> {
		let payload = await this.loadReflection(recordId);
		if (!payload) {
			await this.analyzeRecord(recordId);
			payload = await this.loadReflection(recordId);
		}
		if (!payload) throw new Error(`No reflection generated for record: ${recordId}`);

		const config = this.llmConfig();
		let title = `${payload.title || '3R'} 费曼讲解材料`;
		let slides = localFeynmanSlides(payload);
		if (config.apiKey && config.baseUrl && config.model) {
			const url = llmEndpointUrl(config.baseUrl);
			const usesResponses = isResponsesEndpoint(url);
			try {
				const prompt = materialJsonPrompt(payload);
				const response = await fetch(url, {
					method: 'POST',
					headers: llmRequestHeaders(config),
					body: JSON.stringify(usesResponses ? {
						model: config.model,
						instructions: 'You generate Feynman teaching decks for a 3R Journal app. Return compact JSON only.',
						input: prompt,
						max_output_tokens: 1500,
					} : {
						model: config.model,
						messages: [
							{
								role: 'system',
								content: 'You generate Feynman teaching decks for a 3R Journal app. Return compact JSON only.',
							},
							{
								role: 'user',
								content: prompt,
							},
						],
						...chatCompletionOptions(config, 0.3, 1500),
					}),
				});
				if (response.ok) {
					const content = usesResponses ? responseAssistantContent(JSON.parse(await response.text())) : chatAssistantContent(JSON.parse(await response.text()));
					const parsed = parseJsonObjectFromText(content);
					title = firstString(parsed?.title, title);
					slides = normalizeFeynmanSlides(parsed?.slides, payload);
				} else {
					logger.warn('Failed to generate Feynman material via LLM:', response.status, await response.text());
				}
			} catch (error) {
				logger.warn('Failed to generate Feynman material via LLM:', error);
			}
		}

		const markdown = feynmanMaterialMarkdown(payload, title, slides);
		const script = feynmanScriptMarkdown(title, slides);
		const markdownPath = await writeTextToPersistentFile(markdown, `3r-feynman-${recordId}.md`);
		const scriptPath = await writeTextToPersistentFile(script, `3r-feynman-script-${recordId}.md`);
		const base64Pdf = createSimplePdf(title, markdown);
		const pdfPath = `${await persistent3RDir()}/3r-feynman-${recordId}.pdf`;
		await shim.fsDriver().writeFile(pdfPath, base64Pdf, 'base64');
		const jsonPath = await feynmanJsonPath(recordId);
		const material: FeynmanTeachingMaterial = { title, slides, script, markdown, markdownPath, pdfPath, scriptPath, jsonPath };
		await shim.fsDriver().writeFile(jsonPath, JSON.stringify(material), 'utf8');
		const recordWithNote = await this.loadRecord(recordId);
		const existingRefine = markdownSection(recordWithNote.note.body || '', 'Refine');
		const existingFeynmanSection = markdownSubsection(existingRefine, 'Feynman Technique') || markdownSubsection(existingRefine, '费曼 Technique') || markdownSubsection(existingRefine, '费曼讲解材料');
		const refineWithoutFeynman = existingFeynmanSection ? existingRefine.replace(existingFeynmanSection, '').trim() : existingRefine;
		await this.saveNoteSection(recordWithNote.note, 'Refine', [
			refineWithoutFeynman,
			'',
			'## Feynman Technique',
			`- Markdown/PPT 大纲: ${markdownPath}`,
			`- PDF 讲义: ${pdfPath}`,
			`- 讲解词: ${scriptPath}`,
		].join('\n').trim());
		return material;
	}

	public static async loadFeynmanTeachingMaterial(recordId: string): Promise<FeynmanTeachingMaterial | null> {
		const jsonPath = await feynmanJsonPath(recordId);
		if (!await shim.fsDriver().exists(jsonPath)) return null;
		try {
			const material = asRecord(JSON.parse(await shim.fsDriver().readFile(jsonPath, 'utf8')));
			if (!material) return null;
			const slides = normalizeFeynmanSlides(material.slides, await this.loadReflection(recordId) ?? {
				recordId,
				noteId: '',
				title: firstString(material.title, 'Feynman Technique'),
				generatedAt: Date.now(),
				sourceHash: '',
				textSummary: '',
				keyPoints: [],
				recommendations: [],
				keywords: [],
				suggestedTags: [],
				llmProvider: 'local-fallback',
				textMemory: { embedding: [], summary: '' },
				imageMemories: [],
				audioTranscripts: [],
				videoBreakdown: [],
				documentMemories: [],
				relations: [],
				mindMap: { nodes: [], edges: [] },
				markdown: '',
			});
			return {
				title: firstString(material.title, 'Feynman Technique'),
				slides,
				script: firstString(material.script),
				markdown: firstString(material.markdown),
				markdownPath: firstString(material.markdownPath),
				pdfPath: firstString(material.pdfPath),
				scriptPath: firstString(material.scriptPath),
				jsonPath,
			};
		} catch (error) {
			logger.warn('Failed to load Feynman material:', error);
			return null;
		}
	}

	public static async scheduleFlashcardReminder(card: RecordFlashcard): Promise<void> {
		try {
			const record = await RecordDatabase.loadById(card.record_id);
			if (!record) return;
			await AlarmService.driver().scheduleNotification({
				id: reviewNotificationId(card.id),
				noteId: record.note_id,
				date: new Date(card.due_time),
				title: '3R 精进复习',
				body: card.front,
			});
		} catch (error) {
			logger.warn('Failed to schedule flashcard reminder:', error);
		}
	}

	public static async reviewFlashcard(card: RecordFlashcard, quality: 'again' | 'good' | 'easy'): Promise<RecordFlashcard> {
		const factorChange = quality === 'easy' ? 0.25 : quality === 'again' ? -0.2 : 0;
		const easeFactor = Math.max(1.3, card.ease_factor + factorChange);
		const intervalDays = quality === 'again' ? 1 : Math.max(1, Math.round(card.interval_days * easeFactor));
		const updated: RecordFlashcard = {
			...card,
			ease_factor: easeFactor,
			interval_days: intervalDays,
			review_count: card.review_count + 1,
			due_time: Date.now() + intervalDays * 24 * 60 * 60 * 1000,
			updated_time: Date.now(),
		};
		await RecordDatabase.updateFlashcard(card.id, updated);
		await this.scheduleFlashcardReminder(updated);
		return updated;
	}

	public static async updateFlashcardText(cardId: string, front: string, back: string): Promise<void> {
		await RecordDatabase.updateFlashcard(cardId, { front, back, updated_time: Date.now() });
	}

	public static async updateFlashcardLayout(cardId: string, positionX: number, positionY: number, groupKey: string): Promise<void> {
		await RecordDatabase.updateFlashcard(cardId, {
			position_x: Math.round(positionX),
			position_y: Math.round(positionY),
			group_key: groupKey,
			updated_time: Date.now(),
		});
	}

	public static async exportFlashcardsMarkdown(recordId?: string): Promise<string> {
		const cards = await RecordDatabase.flashcards(recordId);
		const markdown = [
			'# 3R Refine Flashcards',
			'',
			...cards.flatMap((card, index) => [
				`## Card ${index + 1}`,
				`Front: ${card.front}`,
				'',
				`Back: ${card.back}`,
				'',
				`Group: ${card.group_key}`,
				`Next review: ${new Date(card.due_time).toISOString()}`,
				'',
			]),
		].join('\n');
		return await writeTextToCacheFile(markdown, `3r-refine-${recordId || 'all'}.md`);
	}

	public static async exportFlashcardsPdf(recordId?: string): Promise<string> {
		const markdownPath = await this.exportFlashcardsMarkdown(recordId);
		const markdown = await shim.fsDriver().readFile(markdownPath, 'utf8');
		const base64Pdf = createSimplePdf('3R Refine Flashcards', markdown);
		const pdfPath = `${shim.fsDriver().getCacheDirectoryPath()}/sharedFiles/3r-refine-${recordId || 'all'}.pdf`;
		await shim.fsDriver().writeFile(pdfPath, base64Pdf, 'base64');
		return pdfPath;
	}

	public static async ask3R(recordId: string, question: string): Promise<string> {
		const query = question.trim();
		if (!query) return '';
		const { note, record, tags } = await this.loadRecord(recordId);
		const reflection = await this.loadReflection(recordId);
		const cards = await RecordDatabase.flashcards(recordId);
		const reflectMarkdown = reflection?.markdown || markdownSection(note.body || '', 'Reflect');
		const refineMarkdown = markdownSection(note.body || '', 'Refine');
		const searchCorpus = [
			note.title || '',
			markdownSection(note.body || '', 'Record') || note.body || '',
			reflectMarkdown,
			refineMarkdown,
			...(reflection?.recommendations || []),
			...cards.flatMap(card => [card.front, card.back]),
		].filter(Boolean).map(item => `${item}`);
		const queryTokens = topKeywords(query, 8).map(item => item.token);
		const matchingSnippets = searchCorpus
			.filter(text => queryTokens.length === 0 || queryTokens.some(token => text.toLowerCase().includes(token.toLowerCase())))
			.slice(0, 8);
		const context = [
			`Title: ${note.title || 'Untitled'}`,
			`Entry type: ${record.entry_type}`,
			`Tags: ${tags.join(', ')}`,
			'Record / Reflect / Refine context:',
			searchCorpus.join('\n\n').slice(0, 16000),
			matchingSnippets.length ? `Search matches:\n${matchingSnippets.join('\n---\n')}` : '',
			`Question: ${query}`,
		].filter(Boolean).join('\n\n');
		try {
			const answer = await callLlmTextWithFallback(
				'You are Ask 3R inside a 3R Journal Refine page. Answer in Chinese. Search the provided context, synthesize a concise answer, then give structured suggestions and one next action. Use a growth mindset and avoid inventing facts not grounded in the context.',
				context,
				0.2,
				700,
			);
			if (answer) return answer;
		} catch (error) {
			logger.warn('Ask 3R LLM failed, using local answer:', error);
		}
		return [
			'Relevant context',
			...(matchingSnippets.length ? matchingSnippets : searchCorpus.slice(0, 3)).map(item => `- ${item.slice(0, 240)}`),
			'',
			'Suggestion',
			'Use this question to update the Reflect summary, add one concrete next action, and generate a flashcard for later review.',
		].join('\n');
	}

	public static async recordShare(recordId: string, target: 'discord' | 'instagram' | 'youtube', contentType: string): Promise<void> {
		await RecordDatabase.insertShareEvent({
			id: uuid.create(),
			record_id: recordId,
			target: socialTargetNames[target] || target,
			content_type: contentType,
			created_time: Date.now(),
		});
	}

	private static async enqueueRecordsNeedingProcessing(): Promise<void> {
		const records = await RecordService.listRecords({ limit: 200 });
		for (const item of records.slice().reverse()) {
			const existingReflection = await RecordDatabase.latestReflection(item.record.id);
			if (existingReflection) continue;

			await RecordDatabase.enqueueReflectRefine(item.record.id, 0, item.record.created_time);
		}
	}

	private static async processQueuedRecord(recordId: string, forceRefresh = false): Promise<void> {
		if (this.activeRecordIds_.has(recordId)) return;
		this.activeRecordIds_.add(recordId);
		await RecordDatabase.updateProcessingQueueStatus(recordId, 'running');
		try {
			const existingReflection = await RecordDatabase.latestReflection(recordId);
			if (forceRefresh || !existingReflection) {
				await this.analyzeRecord(recordId, { requireConfiguredLlm: true });
			}
			await RecordDatabase.updateProcessingQueueStatus(recordId, 'done');
		} catch (error) {
			await RecordDatabase.updateProcessingQueueStatus(recordId, 'error', `${error}`);
			throw error;
		} finally {
			this.activeRecordIds_.delete(recordId);
		}
	}

	public static async triggerManualReflect(recordId: string): Promise<void> {
		if (!await this.verifyLlmConfiguration(true)) {
			throw new Error('LLM API 配置检查未通过，请先在 3R 设置里配置 API Key、Base URL 和模型。');
		}
		await RecordDatabase.enqueueReflectRefine(recordId, 100, Date.now());
		await this.processQueuedRecord(recordId, true);
	}

	public static async runRecordPipelineNow(recordId: string): Promise<void> {
		return this.triggerManualReflect(recordId);
	}

	public static async runBackgroundPipeline(limit = 3): Promise<void> {
		if (!Setting.value('threeR.backgroundProcessingEnabled')) return;
		if (this.backgroundRunning_) return;
		this.backgroundRunning_ = true;
		try {
			if (!await this.verifyLlmConfiguration()) {
				logger.info('3R background pipeline skipped: LLM API is not verified.');
				return;
			}

			await this.enqueueRecordsNeedingProcessing();
			const queue = await RecordDatabase.pendingProcessingQueue(limit);
			let processed = 0;
			for (const item of queue) {
				try {
					await this.processQueuedRecord(item.record_id);
				} catch (error) {
					logger.warn('3R background pipeline failed for record:', item.record_id, error);
				}
				processed++;
			}
			if (processed) logger.info(`3R background pipeline processed ${processed} record(s).`);
		} catch (error) {
			logger.warn('3R background pipeline failed:', error);
		} finally {
			this.backgroundRunning_ = false;
		}
	}

	public static async dashboardStats(): Promise<RecordDashboardStats> {
		const records = await RecordService.listRecords({ limit: 500 });
		const weekStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
		const reflections = await RecordDatabase.allReflections();
		const cards = await RecordDatabase.flashcards();
		const dueCards = await RecordDatabase.dueFlashcards();
		const shares = await RecordDatabase.shareCount();
		const text = records.map(item => `${item.note.title || ''}\n${markdownSection(item.note.body || '', 'Record') || item.note.body || ''}\n${item.tags.join(' ')}`).join('\n');
		const wordCloud = topKeywords(text, 24).map(item => ({ word: item.token, weight: item.weight }));
		const totalRecords = records.length;
		return {
			weeklyRecords: records.filter(item => item.record.created_time >= weekStart).length,
			totalRecords,
			reflections: reflections.length,
			flashcards: cards.length,
			dueFlashcards: dueCards.length,
			shares,
			followers: Math.max(0, shares * 3 + Math.floor(reflections.length / 2)),
			wordCloud,
			progress: {
				record: totalRecords ? 1 : 0,
				reflect: totalRecords ? Math.min(1, reflections.length / totalRecords) : 0,
				refine: reflections.length ? Math.min(1, cards.length / Math.max(1, reflections.length * 3)) : 0,
				share: totalRecords ? Math.min(1, shares / totalRecords) : 0,
			},
		};
	}

	public static async latestRecord(): Promise<RecordEntry | null> {
		const records = await RecordDatabase.all({ limit: 1 });
		return records[0] ?? null;
	}
}

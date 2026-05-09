import Logger from '@joplin/utils/Logger';

const JSDOMParser = require('@joplin/app-clipper/content_scripts/JSDOMParser');
const Readability = require('@joplin/app-clipper/content_scripts/Readability');

const logger = Logger.create('RecordLinkService');

export type RecordLinkType = 'weblink' | 'youtube';

export interface RecordLinkContent {
	type: RecordLinkType;
	url: string;
	title: string;
	markdown: string;
}

interface ReadabilityArticle {
	title?: string;
	byline?: string;
	dir?: string;
	lang?: string;
	content?: string;
	textContent?: string;
	excerpt?: string;
	siteName?: string;
}

interface DomNode {
	nodeType: number;
	tagName?: string;
	textContent?: string;
	childNodes?: DomNode[];
	getAttribute?: (name: string)=> string | null;
}

interface CaptionTrack {
	baseUrl?: string;
	languageCode?: string;
	name?: {
		simpleText?: string;
		runs?: { text?: string }[];
	};
	kind?: string;
}

const textNodeType = 3;
const elementNodeType = 1;

const htmlEntityMap: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: '\'',
	nbsp: ' ',
};

const decodeHtmlEntities = (text: string) => {
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
		const namedEntity = htmlEntityMap[entity.toLowerCase()];
		if (namedEntity) return namedEntity;
		if (entity.startsWith('#x')) return String.fromCharCode(parseInt(entity.slice(2), 16));
		if (entity.startsWith('#')) return String.fromCharCode(parseInt(entity.slice(1), 10));
		return _match;
	});
};

const normalizeWhitespace = (text: string) => {
	return text.replace(/[ \t\r\f\v]+/g, ' ');
};

const normalizeMarkdown = (markdown: string) => {
	return markdown
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
};

const absoluteUrl = (value: string, baseUrl: string) => {
	try {
		return new URL(value, baseUrl).toString();
	} catch (error) {
		return value;
	}
};

const childrenToMarkdown = (node: DomNode, baseUrl: string) => {
	return Array.from(node.childNodes || []).map(child => nodeToMarkdown(child, baseUrl)).join('');
};

const block = (content: string) => {
	const normalized = normalizeMarkdown(content);
	return normalized ? `\n\n${normalized}\n\n` : '';
};

const listItemMarkdown = (node: DomNode, baseUrl: string, orderedIndex: number | null) => {
	const prefix = orderedIndex === null ? '- ' : `${orderedIndex}. `;
	const content = normalizeMarkdown(childrenToMarkdown(node, baseUrl)).replace(/\n/g, '\n  ');
	return content ? `${prefix}${content}\n` : '';
};

const nodeToMarkdown = (node: DomNode, baseUrl: string): string => {
	if (node.nodeType === textNodeType) return normalizeWhitespace(decodeHtmlEntities(node.textContent || ''));
	if (node.nodeType !== elementNodeType) return childrenToMarkdown(node, baseUrl);

	const tagName = (node.tagName || '').toLowerCase();
	if (['script', 'style', 'noscript', 'svg', 'canvas', 'form', 'nav', 'footer'].includes(tagName)) return '';

	if (tagName === 'br') return '\n';
	if (/^h[1-6]$/.test(tagName)) {
		const level = Number(tagName.slice(1));
		return block(`${'#'.repeat(level)} ${normalizeMarkdown(childrenToMarkdown(node, baseUrl))}`);
	}
	if (['p', 'div', 'section', 'article', 'main', 'blockquote'].includes(tagName)) {
		const content = childrenToMarkdown(node, baseUrl);
		return tagName === 'blockquote' ? block(`> ${normalizeMarkdown(content).replace(/\n/g, '\n> ')}`) : block(content);
	}
	if (tagName === 'ul' || tagName === 'ol') {
		let orderedIndex = 1;
		const items = Array.from(node.childNodes || []).map(child => {
			if ((child.tagName || '').toLowerCase() !== 'li') return nodeToMarkdown(child, baseUrl);
			const markdown = listItemMarkdown(child, baseUrl, tagName === 'ol' ? orderedIndex : null);
			orderedIndex++;
			return markdown;
		}).join('');
		return block(items);
	}
	if (tagName === 'li') return listItemMarkdown(node, baseUrl, null);
	if (tagName === 'a') {
		const href = node.getAttribute?.('href') || '';
		const label = normalizeMarkdown(childrenToMarkdown(node, baseUrl)) || href;
		if (!href) return label;
		return `[${label}](${absoluteUrl(href, baseUrl)})`;
	}
	if (tagName === 'img') {
		const src = node.getAttribute?.('src') || node.getAttribute?.('data-src') || '';
		if (!src) return '';
		const alt = normalizeMarkdown(node.getAttribute?.('alt') || 'image');
		return `![${alt}](${absoluteUrl(src, baseUrl)})`;
	}
	if (tagName === 'tr') return `${normalizeMarkdown(childrenToMarkdown(node, baseUrl))}\n`;
	if (['td', 'th'].includes(tagName)) return `${normalizeMarkdown(childrenToMarkdown(node, baseUrl))} | `;

	return childrenToMarkdown(node, baseUrl);
};

const markdownFromHtml = (html: string, url: string) => {
	const parser = new JSDOMParser();
	const doc = parser.parse(`<article>${html}</article>`, url) as DomNode;
	return normalizeMarkdown(nodeToMarkdown(doc, url));
};

const metaContent = (html: string, attributeName: 'name' | 'property', attributeValue: string) => {
	const tags = html.match(/<meta\s+[^>]*>/gi) || [];
	for (const tag of tags) {
		const attribute = tag.match(new RegExp(`\\s${attributeName}=["']([^"']*)["']`, 'i'))?.[1] || '';
		if (attribute.toLowerCase() !== attributeValue.toLowerCase()) continue;
		return decodeHtmlEntities(tag.match(/\scontent=["']([^"']*)["']/i)?.[1] || '');
	}
	return '';
};

const titleFromHtml = (html: string) => {
	return decodeHtmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || '');
};

const fetchText = async (url: string, headers: Record<string, string> = {}) => {
	const response = await fetch(url, {
		headers: {
			'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'User-Agent': 'Mozilla/5.0 Joplin Record Link Scraper',
			...headers,
		},
	});
	if (!response.ok) throw new Error(`Request failed: ${response.status}`);
	return {
		text: await response.text(),
		contentType: response.headers.get('content-type') || '',
		statusCode: response.status,
	};
};

const scrapeWebsite = async (url: string): Promise<RecordLinkContent> => {
	const response = await fetchText(url);
	const parser = new JSDOMParser();
	const doc = parser.parse(response.text, url);
	let article: ReadabilityArticle | null = null;
	try {
		article = new Readability(doc).parse();
	} catch (error) {
		logger.warn('Readability failed while scraping link:', url, error);
	}

	const title = normalizeMarkdown(article?.title || metaContent(response.text, 'property', 'og:title') || titleFromHtml(response.text) || url);
	const description = normalizeMarkdown(article?.excerpt || metaContent(response.text, 'name', 'description') || metaContent(response.text, 'property', 'og:description'));
	const markdownBody = article?.content ? markdownFromHtml(article.content, url) : normalizeMarkdown(decodeHtmlEntities(response.text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')));
	const metadata = [
		`Source: [${url}](${url})`,
		response.contentType ? `Content-Type: ${response.contentType}` : '',
		`Status: ${response.statusCode}`,
		article?.siteName ? `Site: ${article.siteName}` : '',
		article?.byline ? `Byline: ${article.byline}` : '',
		description ? `Description: ${description}` : '',
	].filter(Boolean).join('\n');

	return {
		type: 'weblink',
		url,
		title,
		markdown: normalizeMarkdown([
			`# ${title}`,
			metadata,
			markdownBody ? `## Content\n\n${markdownBody}` : '',
		].filter(Boolean).join('\n\n')),
	};
};

export const normalizeRecordLinkUrl = (input: string) => {
	const trimmed = input.trim();
	if (!trimmed) throw new Error('Link cannot be empty');
	const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	const url = new URL(withProtocol);
	if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS links are supported');
	return url.toString();
};

export const youtubeVideoId = (url: string) => {
	const parsed = new URL(normalizeRecordLinkUrl(url));
	const hostname = parsed.hostname.replace(/^www\./, '');
	if (hostname === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0] || '';
	if (!['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(hostname)) return '';
	if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || '';
	if (parsed.pathname.startsWith('/embed/') || parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/').filter(Boolean)[1] || '';
	return '';
};

const extractJsonObject = (text: string, marker: string) => {
	const markerIndex = text.indexOf(marker);
	if (markerIndex < 0) return null;
	const startIndex = text.indexOf('{', markerIndex);
	if (startIndex < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = startIndex; index < text.length; index++) {
		const character = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === '\\') {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}
		if (character === '"') {
			inString = true;
		} else if (character === '{') {
			depth++;
		} else if (character === '}') {
			depth--;
			if (depth === 0) return text.slice(startIndex, index + 1);
		}
	}
	return null;
};

const captionTrackName = (track: CaptionTrack) => {
	return track.name?.simpleText || track.name?.runs?.map(run => run.text || '').join('') || '';
};

const preferredCaptionTrack = (tracks: CaptionTrack[]) => {
	return tracks.find(track => track.languageCode?.startsWith('en') && track.kind !== 'asr')
		|| tracks.find(track => track.languageCode?.startsWith('en'))
		|| tracks.find(track => track.kind !== 'asr')
		|| tracks[0]
		|| null;
};

const formatTimestamp = (seconds: number) => {
	const rounded = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(rounded / 60);
	const remainingSeconds = rounded % 60;
	return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

const parseJson3Transcript = (text: string) => {
	const root = JSON.parse(text);
	if (!Array.isArray(root.events)) return '';
	return root.events.map((event: { tStartMs?: number; segs?: { utf8?: string }[] }) => {
		const segmentText = (event.segs || []).map(segment => segment.utf8 || '').join('').trim();
		if (!segmentText) return '';
		return `[${formatTimestamp((event.tStartMs || 0) / 1000)}] ${segmentText}`;
	}).filter(Boolean).join('\n');
};

const parseXmlTranscript = (text: string) => {
	return Array.from(text.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)).map(match => {
		const start = Number(match[1].match(/\bstart=["']([^"']+)["']/i)?.[1] || '0');
		const segmentText = normalizeWhitespace(decodeHtmlEntities(match[2].replace(/\n/g, ' '))).trim();
		if (!segmentText) return '';
		return `[${formatTimestamp(start)}] ${segmentText}`;
	}).filter(Boolean).join('\n');
};

const fetchYouTubeTranscript = async (track: CaptionTrack) => {
	if (!track.baseUrl) return '';
	const transcriptUrl = track.baseUrl.includes('fmt=') ? track.baseUrl : `${track.baseUrl}&fmt=json3`;
	const response = await fetchText(transcriptUrl, { Accept: 'application/json,text/xml,*/*' });
	try {
		return parseJson3Transcript(response.text);
	} catch (error) {
		return parseXmlTranscript(response.text);
	}
};

const fetchYouTubeOEmbedTitle = async (url: string) => {
	try {
		const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
		if (!response.ok) return '';
		const json = await response.json() as { title?: string };
		return json.title || '';
	} catch (error) {
		return '';
	}
};

const scrapeYouTube = async (url: string, videoId: string): Promise<RecordLinkContent> => {
	const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
	let html = '';
	let title = '';
	let description = '';
	let captionLabel = '';
	let transcript = '';
	try {
		html = (await fetchText(watchUrl)).text;
		title = normalizeMarkdown(metaContent(html, 'property', 'og:title') || titleFromHtml(html));
		description = normalizeMarkdown(metaContent(html, 'property', 'og:description') || metaContent(html, 'name', 'description'));
		const playerResponseText = extractJsonObject(html, 'ytInitialPlayerResponse');
		const playerResponse = playerResponseText ? JSON.parse(playerResponseText) : null;
		const tracks = (playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []) as CaptionTrack[];
		const track = preferredCaptionTrack(tracks);
		captionLabel = track ? captionTrackName(track) : '';
		transcript = track ? await fetchYouTubeTranscript(track) : '';
	} catch (error) {
		logger.warn('Failed to scrape YouTube watch page:', url, error);
	}
	if (!title) title = await fetchYouTubeOEmbedTitle(watchUrl) || `YouTube ${videoId}`;

	const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
	const transcriptSection = transcript
		? `## Transcript${captionLabel ? ` (${captionLabel})` : ''}\n\n${transcript}`
		: [
			'## Transcript',
			'',
			'未找到公开字幕轨。已保存视频链接和关键缩略图，可在有本地视频文件时通过 Record 的视频分析流水线进行抽帧与语音转文字。',
		].join('\n');

	return {
		type: 'youtube',
		url: watchUrl,
		title,
		markdown: normalizeMarkdown([
			`# ${title}`,
			`Source: [${watchUrl}](${watchUrl})`,
			`Video ID: ${videoId}`,
			description ? `Description: ${description}` : '',
			`![YouTube thumbnail](${thumbnailUrl})`,
			transcriptSection,
		].filter(Boolean).join('\n\n')),
	};
};

export default class RecordLinkService {
	public static async scrape(input: string): Promise<RecordLinkContent> {
		const url = normalizeRecordLinkUrl(input);
		const videoId = youtubeVideoId(url);
		if (videoId) return scrapeYouTube(url, videoId);
		return scrapeWebsite(url);
	}
}

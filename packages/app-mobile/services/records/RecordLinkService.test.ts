import RecordLinkService, { normalizeRecordLinkUrl, youtubeVideoId } from './RecordLinkService';

const makeResponse = (text: string, options: { ok?: boolean; status?: number; contentType?: string } = {}) => {
	return {
		ok: options.ok ?? true,
		status: options.status ?? 200,
		text: async () => text,
		json: async () => JSON.parse(text),
		headers: {
			get: (name: string) => name.toLowerCase() === 'content-type' ? options.contentType || 'text/html' : '',
		},
	} as unknown as Response;
};

describe('RecordLinkService', () => {
	beforeEach(() => {
		global.fetch = jest.fn();
	});

	test.each([
		['example.com/page', 'https://example.com/page'],
		['https://example.com/page', 'https://example.com/page'],
	])('normalizes %s', (input, expected) => {
		expect(normalizeRecordLinkUrl(input)).toBe(expected);
	});

	test.each([
		['https://www.youtube.com/watch?v=abcdefghijk', 'abcdefghijk'],
		['https://youtu.be/abcdefghijk', 'abcdefghijk'],
		['https://www.youtube.com/shorts/abcdefghijk', 'abcdefghijk'],
		['https://example.com/watch?v=abcdefghijk', ''],
	])('extracts YouTube id from %s', (input, expected) => {
		expect(youtubeVideoId(input)).toBe(expected);
	});

	test('scrapes website main content to markdown', async () => {
		const mockedFetch = global.fetch as jest.MockedFunction<typeof fetch>;
		mockedFetch.mockResolvedValue(makeResponse(`
			<html>
				<head>
					<title>Example Article</title>
					<meta name="description" content="Short description"/>
				</head>
				<body>
					<nav>Skip navigation</nav>
					<article>
						<h1>Example Article</h1>
						<p>Hello <a href="/next">next page</a>.</p>
					</article>
				</body>
			</html>
		`));

		const result = await RecordLinkService.scrape('https://example.com/article');

		expect(result.type).toBe('weblink');
		expect(result.title).toBe('Example Article');
		expect(result.markdown).toContain('# Example Article');
		expect(result.markdown).toContain('[next page](https://example.com/next)');
		expect(result.markdown).not.toContain('Skip navigation');
	});

	test('scrapes YouTube transcript when public captions are available', async () => {
		const mockedFetch = global.fetch as jest.MockedFunction<typeof fetch>;
		const playerResponse = {
			captions: {
				playerCaptionsTracklistRenderer: {
					captionTracks: [
						{
							baseUrl: 'https://youtube.test/caption?lang=en',
							languageCode: 'en',
							name: { simpleText: 'English' },
						},
					],
				},
			},
		};
		mockedFetch.mockImplementation(async url => {
			const urlString = `${url}`;
			if (urlString.includes('caption')) {
				return makeResponse(JSON.stringify({
					events: [
						{ tStartMs: 0, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
						{ tStartMs: 2000, segs: [{ utf8: 'Second line' }] },
					],
				}), { contentType: 'application/json' });
			}
			return makeResponse(`
				<html>
					<head>
						<meta property="og:title" content="Video title"/>
						<meta property="og:description" content="Video description"/>
					</head>
					<body>
						<script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>
					</body>
				</html>
			`);
		});

		const result = await RecordLinkService.scrape('https://youtu.be/abcdefghijk');

		expect(result.type).toBe('youtube');
		expect(result.title).toBe('Video title');
		expect(result.markdown).toContain('## Transcript (English)');
		expect(result.markdown).toContain('[0:00] Hello world');
		expect(result.markdown).toContain('[0:02] Second line');
	});
});

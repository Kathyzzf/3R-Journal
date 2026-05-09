import shim from '@joplin/lib/shim';
import Logger from '@joplin/utils/Logger';
import { PermissionsAndroid, Platform } from 'react-native';
import unzip from './utils/unzip';
const md5 = require('md5');

const logger = Logger.create('voiceTyping');

const trimTrailingSlashes = (path: string) => path.length > 1 ? path.replace(/\/+$/, '') : path;

const ensureDirectory = async (path: string) => {
	if (!await shim.fsDriver().exists(path)) {
		await shim.fsDriver().mkdir(path);
	}
	if (!await shim.fsDriver().exists(path)) {
		throw new Error(`Could not create directory: ${path}`);
	}
};

const safeDownloadFileName = (modelName: string, locale: string, modelUrl: string) => {
	return `${modelName}-${locale}-${md5(modelUrl)}.zip`.replace(/[^A-Za-z0-9._-]/g, '_');
};

const pathJoin = (basePath: string, relativePath: string) => {
	if (!relativePath) return trimTrailingSlashes(basePath);
	return `${trimTrailingSlashes(basePath)}/${relativePath.replace(/^\/+/, '')}`;
};

const relativeDirname = (path: string) => {
	const index = path.lastIndexOf('/');
	return index < 0 ? '' : path.slice(0, index);
};

const relativeBasename = (path: string) => {
	const index = path.lastIndexOf('/');
	return index < 0 ? path : path.slice(index + 1);
};

interface FsDriverEntry {
	isDirectory(): boolean;
	path: string;
}

interface ExtractedModelArchive {
	entries: FsDriverEntry[];
	modelRoot: string;
}

const ensureRelativeDirectory = async (basePath: string, relativePath: string) => {
	let currentPath = '';
	for (const part of relativePath.split('/').filter(Boolean)) {
		currentPath = currentPath ? `${currentPath}/${part}` : part;
		await ensureDirectory(pathJoin(basePath, currentPath));
	}
};

const modelArchiveFromUnzipDirectory = async (unzipDir: string): Promise<ExtractedModelArchive> => {
	const entries = await shim.fsDriver().readDirStats(unzipDir, { recursive: true });
	const filePaths = entries.filter(entry => !entry.isDirectory()).map(entry => entry.path);
	const modelRoots = filePaths
		.filter(path => relativeBasename(path) === 'model.bin')
		.map(path => relativeDirname(path))
		.filter(root => filePaths.includes(pathJoin(root, 'config.json')))
		.sort((a, b) => a.length - b.length);
	const modelRoot = modelRoots[0];
	if (modelRoot === undefined) {
		logger.error('Voice typing model archive contents:', filePaths);
		throw new Error('Downloaded voice typing model is missing model.bin or config.json');
	}

	return { entries, modelRoot };
};

const pathIsWithinModelRoot = (path: string, modelRoot: string) => {
	if (!modelRoot) return true;
	return path === modelRoot || path.startsWith(`${modelRoot}/`);
};

const modelRootRelativePath = (path: string, modelRoot: string) => {
	if (!modelRoot) return path;
	return path.slice(modelRoot.length + 1);
};

const installModelArchive = async (unzipDir: string, archive: ExtractedModelArchive, targetDirectory: string) => {
	await ensureDirectory(targetDirectory);
	const modelFiles = archive.entries.filter(entry => !entry.isDirectory() && pathIsWithinModelRoot(entry.path, archive.modelRoot));
	for (const entry of modelFiles) {
		const relativePath = modelRootRelativePath(entry.path, archive.modelRoot);
		const targetRelativeDir = relativeDirname(relativePath);
		await ensureRelativeDirectory(targetDirectory, targetRelativeDir);
		await shim.fsDriver().copy(pathJoin(unzipDir, entry.path), pathJoin(targetDirectory, relativePath));
	}

	const requiredPaths = ['model.bin', 'config.json'];
	for (const relativePath of requiredPaths) {
		const targetPath = pathJoin(targetDirectory, relativePath);
		if (!await shim.fsDriver().exists(targetPath)) {
			throw new Error(`Voice typing model install failed. Missing ${relativePath} at ${targetPath}`);
		}
	}
};

export type OnTextCallback = (text: string)=> void;

export interface SpeechToTextCallbacks {
	// Called with a block of text that might change in the future
	onPreview: OnTextCallback;
	// Called with text that will not change and should be added to the document
	onFinalize: OnTextCallback;
}

export interface VoiceTypingSession {
	start(): Promise<void>;
	stop(): Promise<void>;
	cancel(): Promise<void>;
}

export interface BuildProviderOptions {
	locale: string;
	modelPath: string;
	callbacks: SpeechToTextCallbacks;
}

export interface VoiceTypingProvider {
	modelName: string;
	supported(): boolean;
	modelLocalFilepath(locale: string): string;
	deleteCachedModels(locale: string): Promise<void>;
	getDownloadUrl(locale: string): string;
	getUuidPath(locale: string): string;
	build(options: BuildProviderOptions): Promise<VoiceTypingSession>;
}

export default class VoiceTyping {
	private provider: VoiceTypingProvider|null = null;
	public constructor(private locale: string) {
		this.provider = VoiceTyping.providers_.find(p => p.supported()) ?? null;
	}

	private static providers_: VoiceTypingProvider[] = [];
	public static initialize(providers: VoiceTypingProvider[]) {
		this.providers_ = providers;
	}

	public static supported() {
		return this.providers_.some(p => p.supported());
	}

	private getModelPath() {
		const localFilePath = trimTrailingSlashes(shim.fsDriver().resolveRelativePathWithinDir(
			shim.fsDriver().getAppDirectoryPath(),
			this.provider.modelLocalFilepath(this.locale),
		));
		if (localFilePath === shim.fsDriver().getAppDirectoryPath()) {
			throw new Error('Invalid local file path!');
		}

		return localFilePath;
	}

	private getUuidPath() {
		return shim.fsDriver().resolveRelativePathWithinDir(
			shim.fsDriver().getAppDirectoryPath(),
			this.provider.getUuidPath(this.locale),
		);
	}

	public async isDownloadedFromOutdatedUrl() {
		const uuidPath = this.getUuidPath();
		if (!await shim.fsDriver().exists(uuidPath)) {
			// Not downloaded at all
			return false;
		}

		const modelUrl = this.provider.getDownloadUrl(this.locale);
		const urlHash = await shim.fsDriver().readFile(uuidPath);
		return urlHash.trim() !== md5(modelUrl);
	}

	public async isDownloaded() {
		return await shim.fsDriver().exists(this.getUuidPath());
	}

	public async clearDownloads() {
		await this.provider.deleteCachedModels(this.locale);
	}

	public async download() {
		const modelPath = this.getModelPath();
		const modelUrl = this.provider.getDownloadUrl(this.locale);
		const modelParentPath = relativeDirname(modelPath);
		await ensureDirectory(modelParentPath);

		await shim.fsDriver().remove(modelPath);
		logger.info(`Downloading model from: ${modelUrl}`);

		const isZipped = modelUrl.endsWith('.zip');
		const downloadDir = `${shim.fsDriver().getCacheDirectoryPath()}/voice-typing-downloads/${this.provider.modelName}`;
		if (isZipped) await ensureDirectory(downloadDir);
		const downloadPath = isZipped ? `${downloadDir}/${safeDownloadFileName(this.provider.modelName, this.locale, modelUrl)}` : modelPath;
		await shim.fsDriver().remove(downloadPath);
		const response = await shim.fetchBlob(modelUrl, {
			path: downloadPath,
		});

		if (!response.ok || response.status >= 400) throw new Error(`Could not download from ${modelUrl}: Error ${response.status}`);

		if (isZipped) {
			const modelName = this.provider.modelName;
			const unzipDir = `${shim.fsDriver().getCacheDirectoryPath()}/voice-typing-extract/${modelName}/${this.locale}`;
			try {
				logger.info(`Unzipping ${downloadPath} => ${unzipDir}`);

				await shim.fsDriver().remove(unzipDir);
				await ensureDirectory(unzipDir);
				await unzip(downloadPath, unzipDir);

				const archive = await modelArchiveFromUnzipDirectory(unzipDir);
				logger.info(`Installing ${pathJoin(unzipDir, archive.modelRoot)} => ${modelPath}`);
				await ensureDirectory(modelParentPath);
				await shim.fsDriver().remove(modelPath);
				await ensureDirectory(modelPath);
				await installModelArchive(unzipDir, archive, modelPath);
			} finally {
				await shim.fsDriver().remove(unzipDir);
				await shim.fsDriver().remove(downloadPath);
			}
		}

		await shim.fsDriver().writeFile(this.getUuidPath(), md5(modelUrl), 'utf8');
		if (!await this.isDownloaded()) {
			logger.warn('Model should be downloaded!');
		} else {
			logger.info('Model stats', await shim.fsDriver().stat(modelPath));
		}
	}

	public async build(callbacks: SpeechToTextCallbacks) {
		if (!this.provider) {
			throw new Error('No supported provider found!');
		}

		if (!await this.isDownloaded()) {
			await this.download();
		}

		const audioPermission = 'android.permission.RECORD_AUDIO';
		if (Platform.OS === 'android' && !await PermissionsAndroid.check(audioPermission)) {
			await PermissionsAndroid.request(audioPermission);
		}

		return this.provider.build({
			locale: this.locale,
			modelPath: this.getModelPath(),
			callbacks,
		});
	}
}

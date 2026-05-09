import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Image, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ThemeStyle } from '../../global-style';
import createStyles from './styles';
import RecordService, { RecordWithNote } from '../../../services/records/RecordService';
import RecordAnalysisService, { RecordReflectionPayload } from '../../../services/records/RecordAnalysisService';
import Logger from '@joplin/utils/Logger';
import { _ } from '@joplin/lib/locale';

const logger = Logger.create('RecordReflectView');

const fileUri = (path: string) => {
	if (!path) return '';
	if (path.startsWith('file://') || path.startsWith('data:')) return path;
	return encodeURI(`file://${path}`);
};

const pendingImageOcrMessage = () => _('Waiting for the Joplin OCR/ASR background service to write the resource text, or run OCR on the images in this Record entry.');
const pendingAudioAsrMessage = () => _('Waiting for ASR results, or for the Joplin OCR/ASR background service to write the resource text.');
const pendingVideoBreakdownMessage = () => _('Waiting for video frame capture or ASR breakdown results.');

const formatTimestamp = (timestampMs: number) => {
	const totalSeconds = Math.max(0, Math.round(timestampMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

interface Props {
	theme: ThemeStyle;
	recordId?: string;
}

const RecordReflectView: React.FC<Props> = ({ theme, recordId }) => {
	const styles = useMemo(() => createStyles(theme), [theme]);
	const [records, setRecords] = useState<RecordWithNote[]>([]);
	const [selectedRecordId, setSelectedRecordId] = useState('');
	const [reflection, setReflection] = useState<RecordReflectionPayload | null>(null);
	const [loading, setLoading] = useState(true);
	const [processing, setProcessing] = useState(false);
	const [savingReflect, setSavingReflect] = useState(false);
	const [previewPath, setPreviewPath] = useState('');
	const [reflectDraft, setReflectDraft] = useState('');
	const [lastSavedReflectDraft, setLastSavedReflectDraft] = useState('');
	const [promptDraft, setPromptDraft] = useState(RecordAnalysisService.defaultReflectPrompt());

	const selectedRecord = records.find(item => item.record.id === selectedRecordId) ?? null;
	const recommendations = reflection?.recommendations ?? [];
	const embedding = reflection?.textMemory?.embedding ?? [];
	const imageMemories = reflection?.imageMemories ?? [];
	const audioTranscripts = reflection?.audioTranscripts ?? [];
	const videoBreakdown = reflection?.videoBreakdown ?? [];
	const documentMemories = reflection?.documentMemories ?? [];
	const suggestedTags = reflection?.suggestedTags ?? [];
	const relations = reflection?.relations ?? [];
	const mindMapNodes = reflection?.mindMap?.nodes ?? [];
	const mindMapEdges = reflection?.mindMap?.edges ?? [];
	const nodeLabels = useMemo(() => new Map(mindMapNodes.map(node => [node.id, node.label])), [mindMapNodes]);
	const mediaMemoryCount = imageMemories.length + audioTranscripts.length + videoBreakdown.length;

	const loadRecords = useCallback(async () => {
		setLoading(true);
		try {
			const loaded = recordId ? [await RecordService.getRecord(recordId)].filter(Boolean) as RecordWithNote[] : await RecordService.listRecords({ limit: 50 });
			setRecords(loaded);
			const nextRecordId = recordId || loaded[0]?.record.id || '';
			setSelectedRecordId(current => recordId || current || nextRecordId);
		} catch (error) {
			logger.error('Failed to load records:', error);
			Alert.alert(_('Failed to load records'), `${error}`);
		} finally {
			setLoading(false);
		}
	}, [recordId]);

	useEffect(() => {
		void loadRecords();
	}, [loadRecords]);

	useEffect(() => {
		if (!selectedRecordId) {
			setReflection(null);
			setReflectDraft('');
			setPromptDraft(RecordAnalysisService.defaultReflectPrompt());
			return;
		}
		const loadReflection = async () => {
			try {
				const loadedReflection = await RecordAnalysisService.loadReflection(selectedRecordId);
				setReflection(loadedReflection);
				setReflectDraft(loadedReflection?.markdown || '');
				setLastSavedReflectDraft(loadedReflection?.markdown || '');
			} catch (error) {
				logger.warn('Failed to load reflection:', error);
			}
		};
		void loadReflection();
	}, [selectedRecordId]);

	const analyze = useCallback(async () => {
		if (!selectedRecordId || processing) return;
		setProcessing(true);
		try {
			await RecordAnalysisService.analyzeRecord(selectedRecordId, { requireConfiguredLlm: true, reflectPrompt: promptDraft });
			const loadedReflection = await RecordAnalysisService.loadReflection(selectedRecordId);
			setReflection(loadedReflection);
			setReflectDraft(loadedReflection?.markdown || '');
			setLastSavedReflectDraft(loadedReflection?.markdown || '');
		} catch (error) {
			logger.error('Failed to analyze record:', error);
			Alert.alert(_('Reflect failed'), `${error}`);
		} finally {
			setProcessing(false);
		}
	}, [selectedRecordId, processing, promptDraft]);

	const saveReflectDraft = useCallback(async (showAlert = true) => {
		if (!selectedRecordId || savingReflect) return;
		setSavingReflect(true);
		try {
			const updatedReflection = await RecordAnalysisService.saveEditedReflection(selectedRecordId, reflectDraft);
			setReflection(updatedReflection);
			setReflectDraft(updatedReflection.markdown);
			setLastSavedReflectDraft(updatedReflection.markdown);
			if (showAlert) Alert.alert(_('Reflect saved'), _('Your revised Reflect content has been saved and will be used by Refine.'));
		} catch (error) {
			logger.error('Failed to save Reflect content:', error);
			if (showAlert) Alert.alert(_('Could not save Reflect'), `${error}`);
		} finally {
			setSavingReflect(false);
		}
	}, [selectedRecordId, savingReflect, reflectDraft]);

	useEffect(() => {
		if (!reflection || !selectedRecordId || !reflectDraft || reflectDraft === lastSavedReflectDraft || savingReflect) return undefined;
		const timeoutId = setTimeout(() => {
			void saveReflectDraft(false);
		}, 1000);
		return () => clearTimeout(timeoutId);
	}, [reflection, selectedRecordId, reflectDraft, lastSavedReflectDraft, savingReflect, saveReflectDraft]);

	if (loading) {
		return (
			<View style={styles.loadingContainer}>
				<ActivityIndicator size="large" />
			</View>
		);
	}

	return (
		<ScrollView style={styles.analysisContainer} showsVerticalScrollIndicator={false}>
			<Modal visible={!!previewPath} transparent onRequestClose={() => setPreviewPath('')}>
				<TouchableOpacity style={styles.previewBackdrop} activeOpacity={1} onPress={() => setPreviewPath('')}>
					<Image source={{ uri: fileUri(previewPath) }} style={styles.previewImage} resizeMode="contain" />
					<Text style={styles.previewCloseText}>{_('Close preview')}</Text>
				</TouchableOpacity>
			</Modal>
			{!recordId ? (
				<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.recordSelector}>
					{records.map(item => (
						<TouchableOpacity
							key={item.record.id}
							style={[styles.recordSelectorItem, selectedRecordId === item.record.id && styles.recordSelectorItemSelected]}
							onPress={() => setSelectedRecordId(item.record.id)}
						>
							<Text style={[styles.recordSelectorText, selectedRecordId === item.record.id && styles.recordSelectorTextSelected]} numberOfLines={1}>
								{item.note.title || _('Untitled')}
							</Text>
						</TouchableOpacity>
					))}
				</ScrollView>
			) : null}

			<View style={styles.analysisPanel}>
				<Text style={styles.analysisTitle}>{_('Reflect prompt')}</Text>
				<Text style={styles.analysisBody}>{_('Growth-mindset, structured, and systematic prompt used when generating Reflect.')}</Text>
				<TextInput
					style={styles.promptEditor}
					value={promptDraft}
					onChangeText={setPromptDraft}
					multiline
					textAlignVertical="top"
					selectionColor={theme.textSelectionColor}
					cursorColor={theme.textSelectionColor}
					keyboardAppearance={theme.keyboardAppearance}
				/>
				<TouchableOpacity
					style={[styles.primaryActionButton, (!selectedRecordId || processing) && styles.saveButtonDisabled]}
					onPress={analyze}
					disabled={!selectedRecordId || processing}
				>
					<Text style={styles.primaryActionButtonText}>{processing ? _('Analyzing...') : reflection ? _('Regenerate Reflect') : _('Generate Reflect')}</Text>
				</TouchableOpacity>
			</View>
			{selectedRecord ? (
				<View style={styles.analysisPanel}>
					<Text style={styles.analysisTitle}>{selectedRecord.note.title || _('Current record')}</Text>
					<Text style={styles.analysisMeta}>{_('Type: %s', selectedRecord.record.entry_type)}  {_('Tags: %s', selectedRecord.tags.join(', ') || _('None'))}</Text>
				</View>
			) : null}

			{reflection ? (
				<>
					<View style={styles.analysisPanel}>
						<Text style={styles.analysisTitle}>{_('Revised Reflect content')}</Text>
						<TextInput
							style={styles.reflectEditor}
							value={reflectDraft}
							onChangeText={setReflectDraft}
							onEndEditing={() => void saveReflectDraft(false)}
							multiline
							textAlignVertical="top"
							selectionColor={theme.textSelectionColor}
							cursorColor={theme.textSelectionColor}
							keyboardAppearance={theme.keyboardAppearance}
						/>
							<TouchableOpacity
								style={[styles.primaryActionButton, savingReflect && styles.saveButtonDisabled]}
								onPress={() => void saveReflectDraft()}
								disabled={savingReflect}
							>
							<Text style={styles.primaryActionButtonText}>{savingReflect ? _('Saving...') : _('Save Reflect')}</Text>
						</TouchableOpacity>
					</View>

					<View style={styles.analysisPanel}>
						<Text style={styles.analysisTitle}>{_('Extracted text summary')}</Text>
						<Text style={styles.analysisBody}>{reflection.textSummary}</Text>
						<Text style={styles.analysisMeta}>{_('Analysis source: %s', reflection.llmProvider === 'configured' ? 'LLM' : _('local extraction'))}</Text>
					</View>

					<View style={styles.analysisPanel}>
						<Text style={styles.analysisTitle}>{_('Suggested actions')}</Text>
						{recommendations.map((item, index) => (
							<Text key={`rec-${index}`} style={styles.analysisListItem}>- {item}</Text>
						))}
					</View>

					<View style={styles.analysisPanel}>
						<Text style={styles.analysisTitle}>{_('Text and image dual-coding memory')}</Text>
						<Text style={styles.analysisBody}>{_('Text summary: %s', reflection.textMemory.summary || reflection.textSummary)}</Text>
						<Text style={styles.analysisBody}>{_('Text vector: %s', embedding.map(item => `${item.token}:${item.weight}`).join(', ') || _('No text vector yet'))}</Text>
						{imageMemories.length === 0 ? (
							<Text style={styles.analysisBody}>{_('This record has no image memory yet. Add images or wait for OCR output to show image-text details.')}</Text>
						) : null}
						{imageMemories.map((memory, index) => (
							<View key={`img-${index}`} style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 8 }}>
								{memory.resourcePath ? (
									<TouchableOpacity style={[styles.mediaThumbButton, { marginRight: 12 }]} onPress={() => setPreviewPath(memory.resourcePath || '')}>
										<Image source={{ uri: fileUri(memory.resourcePath) }} style={styles.mediaThumb} resizeMode="cover" />
										<Text style={styles.mediaThumbText} numberOfLines={1}>{memory.title}</Text>
									</TouchableOpacity>
								) : null}
								<View style={{ flex: 1 }}>
									<Text style={styles.analysisBody}>{_('Image details: %s', memory.title)}</Text>
									<Text style={styles.analysisListItem}>{_('OCR text: %s', memory.ocrText || pendingImageOcrMessage())}</Text>
									<Text style={styles.analysisListItem}>{_('Image memory: %s', memory.visualMemory)}</Text>
									<Text style={styles.analysisListItem}>{_('Related concepts: %s', memory.textMemory.join(', ') || _('None'))}</Text>
								</View>
							</View>
						))}
					</View>

					<View style={styles.analysisPanel}>
						<Text style={styles.analysisTitle}>{_('OCR / ASR / video breakdown')}</Text>
						{mediaMemoryCount === 0 ? (
							<Text style={styles.analysisBody}>{_('This record has no matching media content.')}</Text>
						) : null}
						{imageMemories.map((memory, index) => (
							<Text key={`ocr-${index}`} style={styles.analysisBody}>{_('Image OCR - %s: %s', memory.title, memory.ocrText || pendingImageOcrMessage())}</Text>
						))}
						{audioTranscripts.map((memory, index) => (
							<View key={`aud-${index}`}>
								<Text style={styles.analysisBody}>{_('Audio ASR - %s: %s', memory.title, memory.asrText || pendingAudioAsrMessage())}</Text>
								{(memory.asrSegments ?? []).slice(0, 8).map((segment, segmentIndex) => (
									<Text key={`aud-${index}-seg-${segmentIndex}`} style={styles.analysisListItem}>
										- {formatTimestamp(segment.timestampMs)} {segment.text}
									</Text>
								))}
							</View>
						))}
						{videoBreakdown.map((memory, index) => (
							<View key={`vid-${index}`}>
								<Text style={styles.analysisBody}>{memory.title}</Text>
								<Text style={styles.analysisListItem}>{_('Video ASR: %s', memory.asrText || pendingAudioAsrMessage())}</Text>
								<Text style={styles.analysisMeta}>{_('Captured frame images')}</Text>
								<View style={styles.mediaGrid}>
									{(memory.frameImagePaths ?? []).map((path, frameIndex) => (
										<TouchableOpacity key={`vid-${index}-thumb-${frameIndex}`} style={styles.mediaThumbButton} onPress={() => setPreviewPath(path)}>
											<Image source={{ uri: fileUri(path) }} style={styles.mediaThumb} resizeMode="cover" />
											<Text style={styles.mediaThumbText}>{_('Frame %d %s', frameIndex + 1, formatTimestamp((memory.frameTimestampsMs ?? [])[frameIndex] || 0))}</Text>
										</TouchableOpacity>
									))}
								</View>
								{(memory.frameImagePaths ?? []).length === 0 ? (
									<Text style={styles.analysisListItem}>{pendingVideoBreakdownMessage()}</Text>
								) : null}
								{(memory.frameSummaries ?? []).map((frame, fIndex) => <Text key={`frame-${index}-${fIndex}`} style={styles.analysisListItem}>- {frame}</Text>)}
								{(memory.frameTextAlignments ?? []).length ? (
									<View style={styles.timeline}>
										<Text style={styles.analysisMeta}>{_('Frame and ASR timeline alignment')}</Text>
										{memory.frameTextAlignments.map((alignment, alignmentIndex) => (
											<View key={`align-${index}-${alignmentIndex}`} style={styles.timelineItem}>
												<TouchableOpacity style={styles.timelineThumbButton} onPress={() => setPreviewPath(alignment.framePath)}>
													<Image source={{ uri: fileUri(alignment.framePath) }} style={styles.timelineThumb} resizeMode="cover" />
												</TouchableOpacity>
												<View style={{ flex: 1 }}>
													<Text style={styles.timelineTime}>{formatTimestamp(alignment.timestampMs)}</Text>
													<Text style={styles.analysisListItem}>{alignment.frameSummary || _('Frame %d', alignmentIndex + 1)}</Text>
													<Text style={styles.analysisBody}>{alignment.text || pendingAudioAsrMessage()}</Text>
												</View>
											</View>
										))}
									</View>
								) : null}
							</View>
						))}
					</View>

					<View style={styles.analysisPanel}>
						<Text style={styles.analysisTitle}>{_('Document Markdown / Chunks')}</Text>
						{documentMemories.length === 0 ? (
							<Text style={styles.analysisBody}>{_('This record has no convertible document, or the document conversion result is empty.')}</Text>
						) : null}
						{documentMemories.map((memory, index) => (
							<View key={`doc-${index}`}>
								<Text style={styles.analysisBody}>{_('%s: %d chunks', memory.title, (memory.documentChunks ?? []).length)}</Text>
								{memory.documentMarkdownPath ? <Text style={styles.analysisMeta}>Markdown: {memory.documentMarkdownPath}</Text> : null}
								{memory.documentTextPath ? <Text style={styles.analysisMeta}>Text: {memory.documentTextPath}</Text> : null}
								{memory.documentChunkPath ? <Text style={styles.analysisMeta}>Chunks: {memory.documentChunkPath}</Text> : null}
								{memory.documentMarkdown ? <Text style={styles.analysisListItem}>{memory.documentMarkdown.slice(0, 240)}</Text> : null}
								{(memory.documentChunks ?? []).slice(0, 3).map((chunk, chunkIndex) => (
									<Text key={`doc-${index}-chunk-${chunkIndex}`} style={styles.analysisListItem}>- {chunk.heading}: {chunk.text.slice(0, 120)}</Text>
								))}
							</View>
						))}
					</View>

					<View style={styles.analysisPanel}>
						<Text style={styles.analysisTitle}>{_('Tag categories and related groups')}</Text>
						<View style={styles.tagChipsRow}>
							{suggestedTags.map((tag, index) => (
								<View key={`tag-${index}`} style={styles.cardTag}>
									<Text style={styles.cardTagText}>{tag}</Text>
								</View>
							))}
						</View>
						{relations.slice(0, 8).map((item, index) => (
							<Text key={`rel-${index}`} style={styles.analysisListItem}>- {item.from} → {item.to}: {item.relation}</Text>
						))}
					</View>

					<View style={styles.analysisPanel}>
						<Text style={styles.analysisTitle}>{_('Mind map')}</Text>
						<View style={styles.mindMap}>
							{mindMapNodes.map((node, index) => (
								<View key={`node-${index}`} style={[styles.mindMapNode, node.kind === 'record' && styles.mindMapNodeRoot]}>
									<Text style={[styles.mindMapNodeText, node.kind === 'record' && styles.mindMapNodeRootText]} numberOfLines={2}>{node.label}</Text>
								</View>
							))}
						</View>
						<View style={styles.mindMapRelations}>
							{mindMapEdges.slice(0, 10).map((edge, index) => (
								<View key={`edge-${index}`} style={styles.mindMapRelationRow}>
									<Text style={styles.mindMapRelationText} numberOfLines={2}>{nodeLabels.get(edge.from) || edge.from}</Text>
									<Text style={styles.mindMapRelationLabel} numberOfLines={1}>{edge.label}</Text>
									<Text style={styles.mindMapRelationText} numberOfLines={2}>{nodeLabels.get(edge.to) || edge.to}</Text>
								</View>
							))}
						</View>
					</View>
				</>
			) : (
				<View style={styles.emptyState}>
					<Text style={styles.emptyStateText}>{_('Select a record to generate Reflect. Intermediate results will be saved and can be reviewed later.')}</Text>
				</View>
			)}
		</ScrollView>
	);
};

export default RecordReflectView;

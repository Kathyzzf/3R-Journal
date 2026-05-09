import * as React from 'react';
import { useCallback, useContext, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert, Keyboard, Platform } from 'react-native';
import { Dispatch } from 'redux';
import createStyles from './styles';
import { ThemeStyle } from '../../global-style';
import TagSelector from './TagSelector';
import RecordService, { RecordAttachment, RecordWithNote } from '../../../services/records/RecordService';
import { RecordEntryType } from '../../../services/records/RecordDatabase';
import { DialogContext } from '../../DialogManager';
import pickDocument from '../../../utils/pickDocument';
import { launchImageLibrary } from 'react-native-image-picker';
import AudioRecordingBanner from '../../voiceTyping/AudioRecordingBanner';
import { OnFileEvent } from '../../voiceTyping/types';
import Logger from '@joplin/utils/Logger';
import { AttachFileAction } from '../Note/commands/attachFile';
import RecordLinkService from '../../../services/records/RecordLinkService';
import RecordAnalysisService from '../../../services/records/RecordAnalysisService';
import { _ } from '@joplin/lib/locale';

const logger = Logger.create('RecordCreateView');

const threeRFlowSteps = [
	{ title: _('Record'), body: _('Capture today\'s observations, feelings, sketches, or conversations.') },
	{ title: _('Reflect'), body: _('Turn records into themes, relationships, reflection summaries, and next questions.') },
	{ title: _('Refine'), body: _('Turn insights into flashcards, teaching material, and shareable growth work.') },
];

interface Props {
	theme: ThemeStyle;
	onRecordCreated?: (record: RecordWithNote)=> void;
	dispatch?: Dispatch;
}

const RecordCreateView: React.FC<Props> = ({ theme, onRecordCreated, dispatch }) => {
	const styles = createStyles(theme);
	const dialogs = useContext(DialogContext);

	const [text, setText] = useState('');
	const [selectedTags, setSelectedTags] = useState<string[]>([]);
	const [entryType, setEntryType] = useState<RecordEntryType>('text');
	const [sourceUrl, setSourceUrl] = useState('');
	const [sourceTitle, setSourceTitle] = useState('');
	const [pendingAttachments, setPendingAttachments] = useState<RecordAttachment[]>([]);
	const [saving, setSaving] = useState(false);
	const [linkLoading, setLinkLoading] = useState(false);
	const [aiGenerating, setAiGenerating] = useState(false);
	const [showAudioRecorder, setShowAudioRecorder] = useState(false);

	const canSave = !linkLoading && !aiGenerating && (text.trim().length > 0 || pendingAttachments.length > 0 || entryType !== 'text');

	const handleSave = useCallback(async () => {
		if (saving) return;
		setSaving(true);
		try {
			const record = await RecordService.createRecord({
				text: text.trim(),
				tags: selectedTags,
				entryType,
				sourceUrl,
				title: sourceTitle,
				attachments: pendingAttachments,
			});
			setText('');
			setSelectedTags([]);
			setEntryType('text');
			setSourceUrl('');
			setSourceTitle('');
			setPendingAttachments([]);
			Keyboard.dismiss();
			onRecordCreated?.(record);
			Alert.alert(_('Saved to 3R Journal'), _('This record has been saved. Continue recording, or move into Reflect and Refine.'));
		} catch (error) {
			logger.error('Failed to save record:', error);
			Alert.alert(_('Save failed'), `${error}`);
		} finally {
			setSaving(false);
		}
	}, [text, selectedTags, entryType, sourceUrl, sourceTitle, pendingAttachments, saving, onRecordCreated]);

	// Photo/Image
	const handlePhotoPress = useCallback(async () => {
		try {
			const response = await launchImageLibrary({
				mediaType: 'mixed',
				includeBase64: false,
				selectionLimit: 1,
			});

			if (response.didCancel || response.errorCode) return;

			const asset = response.assets?.[0];
			if (asset?.uri) {
				const mediaType = asset.type?.startsWith('video') ? 'video' : 'image';
				setPendingAttachments(prev => [...prev, {
					uri: asset.uri,
					fileName: asset.fileName,
					type: asset.type,
				}]);
				setEntryType(mediaType as RecordEntryType);
			}
		} catch (error) {
			logger.error('Failed to pick image:', error);
		}
	}, []);

	const handleVideoPress = useCallback(async () => {
		try {
			const response = await launchImageLibrary({
				mediaType: 'video',
				includeBase64: false,
				selectionLimit: 1,
			});

			if (response.didCancel || response.errorCode) return;

			const asset = response.assets?.[0];
			if (asset?.uri) {
				setPendingAttachments(prev => [...prev, {
					uri: asset.uri,
					fileName: asset.fileName,
					type: asset.type || 'video/mp4',
				}]);
				setEntryType('video');
			}
		} catch (error) {
			logger.error('Failed to pick video:', error);
		}
	}, []);

	// File attachment
	const handleFilePress = useCallback(async () => {
		try {
			const response = await pickDocument({ multiple: false });
			if (response.length > 0) {
				const file = response[0];
				setPendingAttachments(prev => [...prev, {
					uri: file.uri,
					fileName: file.fileName,
					type: file.type,
				}]);
				if (file.type?.startsWith('audio')) {
					setEntryType('audio');
				} else if (file.type?.startsWith('video')) {
					setEntryType('video');
				} else {
					setEntryType('file');
				}
			}
		} catch (error) {
			logger.error('Failed to pick file:', error);
		}
	}, []);

	// Web link / YouTube
	const handleLinkPress = useCallback(async () => {
		const url = await dialogs.promptForText(_('Enter a web or YouTube link:'));

		if (!url) return;
		if (linkLoading) return;
		setLinkLoading(true);
		try {
			const scraped = await RecordLinkService.scrape(url);
			setText(prev => prev ? `${prev.trim()}\n\n${scraped.markdown}` : scraped.markdown);
			setEntryType(scraped.type);
			setSourceUrl(scraped.url);
			setSourceTitle(scraped.title);
		} catch (error) {
			logger.error('Failed to scrape link:', error);
			Alert.alert(_('Could not read link'), `${error}`);
		} finally {
			setLinkLoading(false);
		}
	}, [dialogs, linkLoading]);

	const handleDrawPress = useCallback(async () => {
		if (saving) return;
		setSaving(true);
		try {
			const result = await RecordService.createRecord({
				text: text.trim(),
				tags: selectedTags,
				entryType: 'drawing',
			});
			setText('');
			setSelectedTags([]);
			setEntryType('text');
			onRecordCreated?.(result);
			dispatch?.({
				type: 'NAV_GO',
				routeName: 'Note',
				noteId: result.note.id,
				newNoteAttachFileAction: AttachFileAction.AttachDrawing,
			});
		} catch (error) {
			logger.error('Failed to open drawing editor:', error);
			Alert.alert(_('Could not open drawing editor'), `${error}`);
		} finally {
			setSaving(false);
		}
	}, [text, selectedTags, saving, onRecordCreated, dispatch]);

	const handleAudioPress = useCallback(() => {
		setShowAudioRecorder(true);
		setEntryType('audio');
	}, []);

	const handleAudioSaved = useCallback((file: OnFileEvent) => {
		setPendingAttachments(prev => [...prev, file]);
		setShowAudioRecorder(false);
		setEntryType('audio');
	}, []);

	const chooseAiGenerationMode = useCallback(() => {
		return new Promise<'image' | 'video' | ''>(resolve => {
			Alert.alert(_('AI generation'), _('Choose what to generate from your description.'), [
				{ text: _('Image'), onPress: () => resolve('image') },
				{ text: _('Video'), onPress: () => resolve('video') },
				{ text: _('Cancel'), style: 'cancel', onPress: () => resolve('') },
			], { cancelable: true, onDismiss: () => resolve('') });
		});
	}, []);

	const handleAiGeneratePress = useCallback(async () => {
		if (aiGenerating) return;
		const mode = await chooseAiGenerationMode();
		if (!mode) return;
		const prompt = await dialogs.promptForText(mode === 'image' ? _('Describe the image to generate:') : _('Describe the short video to generate:'));
		if (!prompt?.trim()) return;
		setAiGenerating(true);
		try {
			if (mode === 'image') {
				const generated = await RecordAnalysisService.generateOpenAiImage(prompt.trim());
				setPendingAttachments(prev => [...prev, generated]);
				setEntryType('image');
				Alert.alert(_('AI image generated'), _('The generated image has been attached to this 3R Journal record.'));
			} else {
				const sourceImage = pendingAttachments.find(attachment => attachment.type?.startsWith('image'));
				const generated = await RecordAnalysisService.generateGoogleVeoVideo(prompt.trim(), sourceImage ? { uri: sourceImage.uri, type: sourceImage.type } : undefined);
				setPendingAttachments(prev => [...prev, generated]);
				setEntryType('video');
				Alert.alert(_('AI video generated'), _('The generated video has been attached to this 3R Journal record.'));
			}
		} catch (error) {
			logger.error('Failed to generate AI media:', error);
			Alert.alert(_('AI generation failed'), `${error}`);
		} finally {
			setAiGenerating(false);
		}
	}, [aiGenerating, chooseAiGenerationMode, dialogs, pendingAttachments]);

	const toolbarButtons = [
		{ icon: '✏️', label: _('Draw'), onPress: handleDrawPress },
		{ icon: '📷', label: _('Image'), onPress: handlePhotoPress },
		{ icon: '🎬', label: _('Video'), onPress: handleVideoPress },
		{ icon: '📎', label: _('File'), onPress: handleFilePress },
		{ icon: '🎧', label: _('Audio'), onPress: handleAudioPress },
		{ icon: '🔗', label: linkLoading ? _('Reading') : _('Link'), onPress: handleLinkPress, disabled: linkLoading },
		{ icon: '✨', label: aiGenerating ? _('Generating') : _('AI生成'), onPress: handleAiGeneratePress, disabled: aiGenerating },
	];

	return (
		<ScrollView
			style={styles.createContainer}
			keyboardShouldPersistTaps="handled"
			showsVerticalScrollIndicator={false}
		>
			{showAudioRecorder && (
				<AudioRecordingBanner
					onFileSaved={handleAudioSaved}
					onDismiss={() => setShowAudioRecorder(false)}
				/>
			)}

			<View style={styles.journalIntro}>
				<Text style={styles.journalIntroTitle}>Creative Journaling Club</Text>
				<Text style={styles.journalIntroText}>
					{_('3R Journal gives students a space to express themselves with illustration, writing, and designed journals. Each record starts from real experience, helping students organize emotions, practice expression, and share themed work with family and community.')}
				</Text>
				<View style={styles.flowSteps}>
					{threeRFlowSteps.map((step, index) => (
						<View key={step.title} style={styles.flowStep}>
							<Text style={styles.flowStepIndex}>{index + 1}</Text>
							<Text style={styles.flowStepTitle}>{step.title}</Text>
							<Text style={styles.flowStepBody}>{step.body}</Text>
						</View>
					))}
				</View>
			</View>

			{/* Text input */}
			<TextInput
				style={styles.textInput}
				value={text}
				onChangeText={setText}
				placeholder={_('Start Record from an image, a sentence, a photo, or a conversation...')}
				placeholderTextColor={theme.colorFaded}
				multiline
				autoCapitalize="sentences"
				selectionColor={theme.textSelectionColor}
				cursorColor={theme.textSelectionColor}
				keyboardAppearance={theme.keyboardAppearance}
			/>

			{/* Quick action toolbar */}
			<View style={styles.toolbar}>
				{toolbarButtons.map(btn => (
					<TouchableOpacity
						key={btn.label}
						style={[styles.toolbarButton, btn.disabled && styles.saveButtonDisabled]}
						onPress={btn.onPress}
						disabled={btn.disabled}
					>
						<Text style={{ fontSize: 24 }}>{btn.icon}</Text>
						<Text style={styles.toolbarButtonText}>{btn.label}</Text>
					</TouchableOpacity>
				))}
			</View>

			{(pendingAttachments.length > 0 || sourceUrl) && (
				<View style={styles.previewSection}>
					<Text style={styles.previewTitle}>{_('Preview')}</Text>
					{pendingAttachments.map((attachment, index) => (
						<Text key={`${attachment.uri}-${index}`} style={styles.previewItem}>
							{attachment.type?.startsWith('audio') ? '🎧' : attachment.type?.startsWith('video') ? '🎬' : attachment.type?.startsWith('image') ? '🖼️' : '📎'} {attachment.fileName || attachment.uri}
						</Text>
					))}
					{sourceUrl ? <Text style={styles.previewItem}>🔗 {sourceUrl}</Text> : null}
				</View>
			)}

			{/* Tag selector */}
			<TagSelector
				theme={theme}
				selectedTags={selectedTags}
				onTagsChange={setSelectedTags}
			/>

			{/* Save button */}
			<TouchableOpacity
				style={[styles.saveButton, (!canSave || saving) && styles.saveButtonDisabled]}
				onPress={handleSave}
				disabled={!canSave || saving}
				activeOpacity={0.8}
			>
				<Text style={styles.saveButtonText}>
					{saving ? _('Saving...') : _('Save and Enter the 3R flow')}
				</Text>
			</TouchableOpacity>

			{/* Spacer for keyboard */}
			{Platform.OS === 'ios' && <View style={{ height: 40 }} />}
		</ScrollView>
	);
};

export default RecordCreateView;

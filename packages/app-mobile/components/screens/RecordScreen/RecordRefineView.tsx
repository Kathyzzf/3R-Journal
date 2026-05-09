import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Share, { Social } from 'react-native-share';
import { ThemeStyle } from '../../global-style';
import createStyles from './styles';
import RecordService, { RecordWithNote } from '../../../services/records/RecordService';
import RecordAnalysisService, { FeynmanTeachingMaterial, RecordReflectionPayload } from '../../../services/records/RecordAnalysisService';
import RecordDatabase, { RecordFlashcard } from '../../../services/records/RecordDatabase';
import shareFile from '../../../utils/shareFile';
import Logger from '@joplin/utils/Logger';
import { _ } from '@joplin/lib/locale';

const logger = Logger.create('RecordRefineView');

interface Props {
	theme: ThemeStyle;
	recordId?: string;
}

const normalizeAnswer = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

const conciseAnswer = (text: string) => {
	const firstLine = text.split('\n').map(line => line.trim()).find(Boolean) || text.trim();
	return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine;
};

const deterministicIndex = (seed: string, modulo: number) => {
	if (modulo <= 0) return 0;
	let hash = 0;
	for (let i = 0; i < seed.length; i++) hash = ((hash * 31) + seed.charCodeAt(i)) % 2147483647;
	return hash % modulo;
};

const flashcardOptions = (card: RecordFlashcard, allCards: RecordFlashcard[], recommendations: string[]) => {
	const correct = conciseAnswer(card.back);
	const distractors = allCards
		.filter(item => item.id !== card.id)
		.map(item => conciseAnswer(item.back))
		.concat(recommendations.map(conciseAnswer))
		.filter(item => item && normalizeAnswer(item) !== normalizeAnswer(correct));
	const unique = Array.from(new Map(distractors.map(item => [normalizeAnswer(item), item])).values());
	const fallbackOptions = [_('Review the original record'), _('Add another example'), _('Create a next action')];
	const options = [correct, ...unique, ...fallbackOptions.filter(item => normalizeAnswer(item) !== normalizeAnswer(correct))]
		.slice(0, 4);
	const start = deterministicIndex(card.id, options.length);
	return options.slice(start).concat(options.slice(0, start));
};

interface FlashcardListItemProps {
	card: RecordFlashcard;
	index: number;
	options: string[];
	selectedAnswer: string;
	theme: ThemeStyle;
	onSelectAnswer: (card: RecordFlashcard, answer: string)=> void;
}

const FlashcardListItem: React.FC<FlashcardListItemProps> = ({ card, index, options, selectedAnswer, theme, onSelectAnswer }) => {
	const styles = useMemo(() => createStyles(theme), [theme]);
	const correctAnswer = conciseAnswer(card.back);
	const hasAnswered = !!selectedAnswer;
	const answeredCorrectly = hasAnswered && normalizeAnswer(selectedAnswer) === normalizeAnswer(correctAnswer);

	return (
		<View style={styles.flashcardListItem}>
			<Text style={styles.flashcardGroup}>{card.group_key || _('General')}</Text>
			<Text style={styles.flashcardQuestion}>{_('Question %d: %s', index + 1, card.front)}</Text>
			{options.map(option => {
				const isSelected = normalizeAnswer(selectedAnswer) === normalizeAnswer(option);
				const isCorrect = normalizeAnswer(option) === normalizeAnswer(correctAnswer);
				const optionStyle = hasAnswered && isCorrect ? styles.flashcardOptionCorrect : hasAnswered && isSelected ? styles.flashcardOptionWrong : null;
				return (
					<TouchableOpacity
						key={option}
						style={[styles.flashcardOption, optionStyle]}
						onPress={() => onSelectAnswer(card, option)}
						disabled={hasAnswered}
					>
						<Text style={[styles.flashcardOptionText, hasAnswered && (isCorrect || isSelected) && styles.flashcardOptionAnswerText]}>{option}</Text>
					</TouchableOpacity>
				);
			})}
			{hasAnswered ? (
				<Text style={[styles.flashcardFeedback, answeredCorrectly ? styles.flashcardFeedbackCorrect : styles.flashcardFeedbackWrong]}>
					{answeredCorrectly ? _('Correct. This card moves forward in your review schedule.') : _('Not quite. Correct answer: %s', correctAnswer)}
				</Text>
			) : null}
		</View>
	);
};

const RecordRefineView: React.FC<Props> = ({ theme, recordId }) => {
	const styles = useMemo(() => createStyles(theme), [theme]);
	const [records, setRecords] = useState<RecordWithNote[]>([]);
	const [selectedRecordId, setSelectedRecordId] = useState('');
	const [cards, setCards] = useState<RecordFlashcard[]>([]);
	const [dueCards, setDueCards] = useState<RecordFlashcard[]>([]);
	const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
	const [reflection, setReflection] = useState<RecordReflectionPayload | null>(null);
	const [feynmanMaterial, setFeynmanMaterial] = useState<FeynmanTeachingMaterial | null>(null);
	const [loading, setLoading] = useState(true);
	const [processing, setProcessing] = useState(false);
	const [materialProcessing, setMaterialProcessing] = useState(false);
	const [askQuery, setAskQuery] = useState('');
	const [askAnswer, setAskAnswer] = useState('');
	const [asking3R, setAsking3R] = useState(false);
	const recommendations = reflection?.recommendations ?? [];
	const feynmanSlides = feynmanMaterial?.slides ?? [];
	const nextReminderCards = cards
		.slice()
		.sort((a, b) => a.due_time - b.due_time)
		.slice(0, 3);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const loaded = recordId ? [await RecordService.getRecord(recordId)].filter(Boolean) as RecordWithNote[] : await RecordService.listRecords({ limit: 50 });
			setRecords(loaded);
			const nextRecordId = recordId || selectedRecordId || loaded[0]?.record.id || '';
			setSelectedRecordId(nextRecordId);
			setCards(nextRecordId ? await RecordDatabase.flashcards(nextRecordId) : []);
			setSelectedAnswers({});
			setReflection(nextRecordId ? await RecordAnalysisService.loadReflection(nextRecordId) : null);
			setFeynmanMaterial(nextRecordId ? await RecordAnalysisService.loadFeynmanTeachingMaterial(nextRecordId) : null);
			setAskAnswer('');
			setDueCards(await RecordDatabase.dueFlashcards());
		} catch (error) {
			logger.error('Failed to load refine data:', error);
		} finally {
			setLoading(false);
		}
	}, [recordId, selectedRecordId]);

	useEffect(() => {
		void load();
	}, [load]);

	const selectRecord = useCallback(async (recordId: string) => {
		setSelectedRecordId(recordId);
		setCards(await RecordDatabase.flashcards(recordId));
		setSelectedAnswers({});
		setReflection(await RecordAnalysisService.loadReflection(recordId));
		setFeynmanMaterial(await RecordAnalysisService.loadFeynmanTeachingMaterial(recordId));
		setAskAnswer('');
	}, []);

	const generateCards = useCallback(async () => {
		if (!selectedRecordId || processing) return;
		setProcessing(true);
		try {
			setCards(await RecordAnalysisService.generateFlashcards(selectedRecordId));
			setSelectedAnswers({});
			setReflection(await RecordAnalysisService.loadReflection(selectedRecordId));
			setDueCards(await RecordDatabase.dueFlashcards());
			Alert.alert(_('Flashcards generated'), _('Review reminders have been scheduled with spaced repetition.'));
		} catch (error) {
			logger.error('Failed to generate flashcards:', error);
			Alert.alert(_('Could not generate flashcards'), `${error}`);
		} finally {
			setProcessing(false);
		}
	}, [selectedRecordId, processing]);

	const ask3R = useCallback(async () => {
		if (!selectedRecordId || asking3R || !askQuery.trim()) return;
		setAsking3R(true);
		try {
			setAskAnswer(await RecordAnalysisService.ask3R(selectedRecordId, askQuery));
		} catch (error) {
			logger.error('Ask 3R failed:', error);
			Alert.alert(_('Ask 3R failed'), `${error}`);
		} finally {
			setAsking3R(false);
		}
	}, [selectedRecordId, asking3R, askQuery]);

	const review = useCallback(async (card: RecordFlashcard, quality: 'again' | 'good' | 'easy') => {
		const updated = await RecordAnalysisService.reviewFlashcard(card, quality);
		setCards(current => current.map(item => item.id === updated.id ? updated : item));
		setDueCards(await RecordDatabase.dueFlashcards());
	}, []);

	const selectAnswer = useCallback(async (card: RecordFlashcard, answer: string) => {
		if (selectedAnswers[card.id]) return;
		setSelectedAnswers(current => ({ ...current, [card.id]: answer }));
		const quality = normalizeAnswer(answer) === normalizeAnswer(conciseAnswer(card.back)) ? 'good' : 'again';
		await review(card, quality);
	}, [review, selectedAnswers]);

	const exportMarkdown = useCallback(async () => {
		const path = await RecordAnalysisService.exportFlashcardsMarkdown(selectedRecordId);
		await shareFile(path, 'text/markdown');
	}, [selectedRecordId]);

	const exportPdf = useCallback(async () => {
		const path = await RecordAnalysisService.exportFlashcardsPdf(selectedRecordId);
		await shareFile(path, 'application/pdf');
	}, [selectedRecordId]);

	const generateFeynmanMaterial = useCallback(async () => {
		if (!selectedRecordId || materialProcessing) return;
		setMaterialProcessing(true);
		try {
			const material = await RecordAnalysisService.generateFeynmanTeachingMaterial(selectedRecordId);
			setFeynmanMaterial(material);
			Alert.alert(_('Feynman Technique generated'), _('The journal-style deck outline, PDF handout, and speaker notes have been saved.'));
		} catch (error) {
			logger.error('Failed to generate Feynman material:', error);
			Alert.alert(_('Could not generate Feynman Technique'), `${error}`);
		} finally {
			setMaterialProcessing(false);
		}
	}, [selectedRecordId, materialProcessing]);

	const shareFeynmanMarkdown = useCallback(async () => {
		if (!feynmanMaterial) return;
		await shareFile(feynmanMaterial.markdownPath, 'text/markdown');
	}, [feynmanMaterial]);

	const shareFeynmanPdf = useCallback(async () => {
		if (!feynmanMaterial) return;
		await shareFile(feynmanMaterial.pdfPath, 'application/pdf');
	}, [feynmanMaterial]);

	const shareFeynmanScript = useCallback(async () => {
		if (!feynmanMaterial) return;
		await shareFile(feynmanMaterial.scriptPath, 'text/markdown');
	}, [feynmanMaterial]);

	const shareTo = useCallback(async (target: 'discord' | 'instagram' | 'youtube') => {
		if (!selectedRecordId) return;
		const path = await RecordAnalysisService.exportFlashcardsMarkdown(selectedRecordId);
		const url = `file://${path}`;
		try {
			if (target === 'discord') {
				await Share.shareSingle({ social: Social.Discord, url, type: 'text/markdown' });
			} else if (target === 'instagram') {
				await Share.shareSingle({ social: Social.Instagram, url, type: 'text/markdown' });
			} else {
				await Share.open({ title: '3R Journal Refine', message: '3R Journal 精进闪卡', url, type: 'text/markdown', failOnCancel: false });
			}
			await RecordAnalysisService.recordShare(selectedRecordId, target, 'flashcards-markdown');
		} catch (error) {
			logger.warn('Share failed:', error);
			Alert.alert(_('Share failed'), `${error}`);
		}
	}, [selectedRecordId]);

	if (loading) {
		return <View style={styles.loadingContainer}><ActivityIndicator size="large" /></View>;
	}

	return (
		<ScrollView style={styles.analysisContainer} showsVerticalScrollIndicator={false}>
			{!recordId ? (
				<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.recordSelector}>
					{records.map(item => (
						<TouchableOpacity
							key={item.record.id}
							style={[styles.recordSelectorItem, selectedRecordId === item.record.id && styles.recordSelectorItemSelected]}
							onPress={() => void selectRecord(item.record.id)}
						>
							<Text style={[styles.recordSelectorText, selectedRecordId === item.record.id && styles.recordSelectorTextSelected]} numberOfLines={1}>
								{item.note.title || _('Untitled')}
							</Text>
						</TouchableOpacity>
					))}
				</ScrollView>
			) : null}

			<View style={styles.analysisPanel}>
				<Text style={styles.analysisTitle}>{_('Ask 3R')}</Text>
				<TextInput
					style={styles.askInput}
					value={askQuery}
					onChangeText={setAskQuery}
					placeholder={_('Search this record and ask for refined answers or suggestions')}
					placeholderTextColor={theme.colorFaded}
					selectionColor={theme.textSelectionColor}
					cursorColor={theme.textSelectionColor}
					keyboardAppearance={theme.keyboardAppearance}
					returnKeyType="search"
					onSubmitEditing={() => void ask3R()}
				/>
				<TouchableOpacity
					style={[styles.primaryActionButton, (!askQuery.trim() || asking3R) && styles.saveButtonDisabled]}
					onPress={ask3R}
					disabled={!askQuery.trim() || asking3R}
				>
					<Text style={styles.primaryActionButtonText}>{asking3R ? _('Searching...') : _('Ask 3R')}</Text>
				</TouchableOpacity>
				{askAnswer ? <Text style={styles.askAnswer}>{askAnswer}</Text> : null}
			</View>

			<View style={styles.analysisPanel}>
				<Text style={styles.analysisTitle}>{_('Review reminders')}</Text>
				<Text style={styles.analysisBody}>{_('Due flashcards: %d. Choose an answer for each card to get instant right or wrong feedback.', dueCards.length)}</Text>
				{nextReminderCards.map(card => (
					<Text key={card.id} style={styles.analysisListItem}>- {card.front}：{new Date(card.due_time).toLocaleString()}</Text>
				))}
				<TouchableOpacity style={[styles.primaryActionButton, processing && styles.saveButtonDisabled]} onPress={generateCards} disabled={processing}>
					<Text style={styles.primaryActionButtonText}>{processing ? _('Generating...') : _('Generate Refine flashcards')}</Text>
				</TouchableOpacity>
			</View>

			<View style={styles.analysisPanel}>
				<Text style={styles.analysisTitle}>{_('Refinement suggestions')}</Text>
				{recommendations.length ? recommendations.map(item => (
					<Text key={item} style={styles.analysisListItem}>- {item}</Text>
				)) : (
					<Text style={styles.analysisBody}>{_('After Reflect runs, refinement suggestions will appear here.')}</Text>
				)}
			</View>

			<View style={styles.analysisPanel}>
				<Text style={styles.analysisTitle}>{_('Feynman Technique')}</Text>
				<Text style={styles.analysisBody}>{_('Generate a journal-style deck outline, PDF handout, and per-slide speaker notes for the current topic, based on the revised Reflect mind map.')}</Text>
				<TouchableOpacity
					style={[styles.primaryActionButton, materialProcessing && styles.saveButtonDisabled]}
					onPress={generateFeynmanMaterial}
					disabled={materialProcessing}
				>
					<Text style={styles.primaryActionButtonText}>{materialProcessing ? _('Generating...') : _('Generate Feynman Technique')}</Text>
				</TouchableOpacity>
				{feynmanMaterial ? (
					<>
						<Text style={styles.analysisMeta}>{_('Markdown/deck outline: %s', feynmanMaterial.markdownPath)}</Text>
						<Text style={styles.analysisMeta}>{_('PDF handout: %s', feynmanMaterial.pdfPath)}</Text>
						<Text style={styles.analysisMeta}>{_('Speaker notes: %s', feynmanMaterial.scriptPath)}</Text>
						{feynmanSlides.map((slide, index) => (
							<View key={`feynman-slide-${index}`} style={styles.materialSlide}>
								<Text style={styles.materialSlideTitle}>{index + 1}. {slide.title}</Text>
								<Text style={styles.analysisMeta}>{_('Visual prompt: %s', slide.visualPrompt)}</Text>
								{slide.bullets.map((item, bulletIndex) => (
									<Text key={`feynman-slide-${index}-bullet-${bulletIndex}`} style={styles.analysisListItem}>- {item}</Text>
								))}
								<Text style={styles.analysisBody}>{_('Speaker notes: %s', slide.speakerNotes)}</Text>
							</View>
						))}
						<View style={styles.exportRow}>
							<TouchableOpacity style={styles.secondaryActionButton} onPress={shareFeynmanMarkdown}><Text style={styles.secondaryActionButtonText}>{_('Share outline')}</Text></TouchableOpacity>
							<TouchableOpacity style={styles.secondaryActionButton} onPress={shareFeynmanPdf}><Text style={styles.secondaryActionButtonText}>{_('Share PDF')}</Text></TouchableOpacity>
							<TouchableOpacity style={styles.secondaryActionButton} onPress={shareFeynmanScript}><Text style={styles.secondaryActionButtonText}>{_('Share speaker notes')}</Text></TouchableOpacity>
						</View>
					</>
				) : null}
			</View>

			<View style={styles.exportRow}>
				<TouchableOpacity style={styles.secondaryActionButton} onPress={exportMarkdown}><Text style={styles.secondaryActionButtonText}>{_('Export Markdown')}</Text></TouchableOpacity>
				<TouchableOpacity style={styles.secondaryActionButton} onPress={exportPdf}><Text style={styles.secondaryActionButtonText}>{_('Export PDF')}</Text></TouchableOpacity>
			</View>
			<View style={styles.exportRow}>
				<TouchableOpacity style={styles.secondaryActionButton} onPress={() => void shareTo('discord')}><Text style={styles.secondaryActionButtonText}>Discord</Text></TouchableOpacity>
				<TouchableOpacity style={styles.secondaryActionButton} onPress={() => void shareTo('instagram')}><Text style={styles.secondaryActionButtonText}>Instagram</Text></TouchableOpacity>
				<TouchableOpacity style={styles.secondaryActionButton} onPress={() => void shareTo('youtube')}><Text style={styles.secondaryActionButtonText}>YouTube</Text></TouchableOpacity>
			</View>

			<View style={styles.flashcardList}>
				<Text style={styles.analysisTitle}>{_('Flashcard practice')}</Text>
				{cards.map((card, index) => (
					<FlashcardListItem
						key={card.id}
						card={card}
						index={index}
						options={flashcardOptions(card, cards, recommendations)}
						selectedAnswer={selectedAnswers[card.id] || ''}
						theme={theme}
						onSelectAnswer={selectAnswer}
					/>
				))}
				{cards.length === 0 ? <Text style={styles.flashcardEmptyText}>{_('No flashcards yet. Generate a set of Refine cards first.')}</Text> : null}
			</View>
		</ScrollView>
	);
};

export default RecordRefineView;

import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, ScrollView } from 'react-native';
import Tag from '@joplin/lib/models/Tag';
import Logger from '@joplin/utils/Logger';
import createStyles from './styles';
import { ThemeStyle } from '../../global-style';
import { _ } from '@joplin/lib/locale';

const presetTags = () => [_('Math'), _('Science'), _('History'), _('Language'), _('Computer science'), _('Reading'), _('Writing'), _('Coding'), _('Exam'), _('Notes')];
const logger = Logger.create('TagSelector');

interface Props {
	theme: ThemeStyle;
	selectedTags: string[];
	onTagsChange: (tags: string[]) => void;
}

const TagSelector: React.FC<Props> = ({ theme, selectedTags, onTagsChange }) => {
	const styles = createStyles(theme);
	const [customTag, setCustomTag] = useState('');
	const [existingTags, setExistingTags] = useState<string[]>([]);

	useEffect(() => {
		const loadTags = async () => {
			try {
				const tags = await Tag.allWithNotes();
				setExistingTags(tags.map(tag => tag.title).filter(Boolean).sort((a, b) => a.localeCompare(b)));
			} catch (error) {
				logger.warn('Failed to load existing tags:', error);
			}
		};
		void loadTags();
	}, []);

	const allTags = useMemo(() => {
		const tags = new Map<string, string>();
		for (const tag of presetTags().concat(existingTags, selectedTags)) {
			const trimmed = tag.trim();
			if (!trimmed) continue;
			tags.set(trimmed.normalize('NFC').toLowerCase(), trimmed);
		}
		return Array.from(tags.values());
	}, [existingTags, selectedTags]);

	const commitTags = useCallback((tags: string[]) => {
		const uniqueTags = new Map<string, string>();
		for (const tag of tags) {
			const trimmed = tag.trim();
			if (!trimmed) continue;
			uniqueTags.set(trimmed.normalize('NFC').toLowerCase(), trimmed);
		}
		onTagsChange(Array.from(uniqueTags.values()));
	}, [onTagsChange]);

	const toggleTag = useCallback((tag: string) => {
		if (selectedTags.includes(tag)) {
			commitTags(selectedTags.filter(t => t !== tag));
		} else {
			commitTags([...selectedTags, tag]);
		}
	}, [selectedTags, commitTags]);

	const addCustomTag = useCallback(() => {
		const trimmed = customTag.trim();
		if (trimmed) {
			commitTags([...selectedTags, trimmed]);
		}
		setCustomTag('');
	}, [customTag, selectedTags, commitTags]);

	return (
		<View style={styles.tagSection}>
			<Text style={styles.tagSectionLabel}>{_('Tags')}</Text>
			<ScrollView horizontal showsHorizontalScrollIndicator={false}>
				<View style={styles.tagChipsRow}>
					{allTags.map(tag => {
						const selected = selectedTags.includes(tag);
						return (
							<TouchableOpacity
								key={tag}
								style={[styles.tagChip, selected && styles.tagChipSelected]}
								onPress={() => toggleTag(tag)}
							>
								<Text style={[styles.tagChipText, selected && styles.tagChipTextSelected]}>
									{selected ? `✓ ${tag}` : tag}
								</Text>
							</TouchableOpacity>
						);
					})}
				</View>
			</ScrollView>
			<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
				<TextInput
					style={[styles.customTagInput, { flex: 1 }]}
					value={customTag}
					onChangeText={setCustomTag}
					onSubmitEditing={addCustomTag}
					placeholder={_('Add a custom tag...')}
					placeholderTextColor={theme.colorFaded}
					selectionColor={theme.textSelectionColor}
					cursorColor={theme.textSelectionColor}
					keyboardAppearance={theme.keyboardAppearance}
					returnKeyType="done"
					blurOnSubmit={false}
				/>
				<TouchableOpacity style={[styles.tagChip, styles.tagChipSelected, { marginTop: 8 }]} onPress={addCustomTag}>
					<Text style={[styles.tagChipText, styles.tagChipTextSelected]}>{_('Add')}</Text>
				</TouchableOpacity>
			</View>
			{selectedTags.length > 0 && (
				<View style={[styles.tagChipsRow, { marginTop: 8 }]}>
					{selectedTags.map(tag => (
						<TouchableOpacity
							key={tag}
							style={[styles.tagChip, styles.tagChipSelected]}
							onPress={() => toggleTag(tag)}
						>
							<Text style={[styles.tagChipText, styles.tagChipTextSelected]}>✕ {tag}</Text>
						</TouchableOpacity>
					))}
				</View>
			)}
		</View>
	);
};

export default TagSelector;

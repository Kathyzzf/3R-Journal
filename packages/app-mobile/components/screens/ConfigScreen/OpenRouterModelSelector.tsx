import * as React from 'react';
import { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, FlatList, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { _ } from '@joplin/lib/locale';
import { themeStyle } from '../../global-style';
import RecordAnalysisService, { LlmModelOption } from '../../../services/records/RecordAnalysisService';
import { ConfigScreenStyles } from './configScreenStyles';
import { UpdateSettingValueCallback } from './types';

interface Props {
	settingId: string;
	provider: string;
	value: string;
	styles: ConfigScreenStyles;
	themeId: number;
	updateSettingValue: UpdateSettingValueCallback;
}

const fallbackOpenAiModels = ['gpt-4o-mini', 'gpt-4o'];

const openAiModels: LlmModelOption[] = [
	{ id: 'gpt-4o-mini', name: 'GPT-4o mini', contextLength: 128000, isFree: false, pricingLabel: '$0.15/$0.60' },
	{ id: 'gpt-4.1-nano', name: 'GPT-4.1 nano', contextLength: 1047576, isFree: false, pricingLabel: '$0.10/$0.40' },
	{ id: 'gpt-5-mini', name: 'GPT-5 mini', contextLength: 400000, isFree: false, pricingLabel: '$0.25/$2.00' },
	{ id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', contextLength: 1047576, isFree: false, pricingLabel: '$0.40/$1.60' },
	{ id: 'gpt-5-nano', name: 'GPT-5 nano', contextLength: 400000, isFree: false, pricingLabel: '$0.05/$0.40' },
	{ id: 'gpt-5', name: 'GPT-5', contextLength: 400000, isFree: false, pricingLabel: '$1.25/$10.00' },
	{ id: 'gpt-4.1', name: 'GPT-4.1', contextLength: 1047576, isFree: false, pricingLabel: '$2.00/$8.00' },
	{ id: 'gpt-4o', name: 'GPT-4o', contextLength: 128000, isFree: false, pricingLabel: '$2.50/$10.00' },
];

const googleModels: LlmModelOption[] = [
	{ id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', contextLength: 1048576, isFree: false, pricingLabel: 'Gemini 3.1' },
	{ id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash-Lite Preview', contextLength: 1048576, isFree: false, pricingLabel: 'Gemini 3.1' },
	{ id: 'gemini-3.1-flash-image-preview', name: 'Gemini 3.1 Flash Image Preview', contextLength: 1048576, isFree: false, pricingLabel: 'Gemini image' },
	{ id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', contextLength: 1048576, isFree: false, pricingLabel: 'Gemini 3' },
	{ id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', contextLength: 1048576, isFree: false, pricingLabel: 'Gemini 3' },
	{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextLength: 1048576, isFree: false, pricingLabel: 'Gemini' },
	{ id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', contextLength: 1048576, isFree: false, pricingLabel: 'Gemini' },
	{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextLength: 1048576, isFree: false, pricingLabel: 'Gemini' },
	{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextLength: 1048576, isFree: false, pricingLabel: 'Gemini' },
	{ id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash-Lite', contextLength: 1048576, isFree: false, pricingLabel: 'Gemini' },
];

const localStyles = StyleSheet.create({
	fullNameScroll: {
		marginLeft: 12,
		marginRight: 12,
		marginBottom: 8,
	},
	modelButtonWrapper: {
		flex: 1,
	},
	modalRoot: {
		flex: 1,
		justifyContent: 'center',
		backgroundColor: 'rgba(0,0,0,0.45)',
		padding: 16,
	},
	modalPanel: {
		borderRadius: 8,
		maxHeight: '86%',
		overflow: 'hidden',
	},
	searchInput: {
		borderWidth: 1,
		borderRadius: 8,
		paddingHorizontal: 12,
		paddingVertical: 8,
		margin: 12,
	},
	modelItem: {
		paddingHorizontal: 14,
		paddingVertical: 11,
		borderTopWidth: 1,
	},
	modelItemSelected: {
		borderLeftWidth: 4,
	},
	modalFooter: {
		padding: 12,
	},
});

const contextLengthLabel = (contextLength: number) => {
	if (!contextLength) return '';
	if (contextLength >= 1000) return `${Math.round(contextLength / 1000)}k`;
	return `${contextLength}`;
};

const modelLabel = (model: LlmModelOption) => {
	const context = contextLengthLabel(model.contextLength);
	const badges = [model.isFree ? 'free' : model.pricingLabel, context].filter(Boolean).join(', ');
	return badges ? `${model.name} (${model.id}, ${badges})` : `${model.name} (${model.id})`;
};

const OpenRouterModelSelector: FunctionComponent<Props> = props => {
	const { settingId, provider, value, styles, themeId, updateSettingValue } = props;
	const usesOpenRouter = provider === 'openrouter';
	const usesGoogle = provider === 'google';
	const [models, setModels] = useState<LlmModelOption[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const [selectorVisible, setSelectorVisible] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const valueRef = useRef(value);
	const styleSheet = styles.styleSheet;
	const theme = themeStyle(themeId);
	const containerStyles = styles.getContainerStyle(true);

	useEffect(() => {
		valueRef.current = value;
	}, [value]);

	const loadModels = useCallback(async () => {
		setLoading(true);
		setError('');
		try {
			const loadedModels = usesOpenRouter ? await RecordAnalysisService.fetchOpenRouterModels() : usesGoogle ? googleModels : openAiModels;
			setModels(loadedModels);
			const currentValue = valueRef.current;
			if (loadedModels.length && (!currentValue || (usesOpenRouter && fallbackOpenAiModels.includes(currentValue)))) {
				void updateSettingValue(settingId, loadedModels[0].id);
			}
		} catch (error) {
			setError(`${error}`);
		} finally {
			setLoading(false);
		}
	}, [settingId, updateSettingValue, usesGoogle, usesOpenRouter]);

	useEffect(() => {
		void loadModels();
	}, [loadModels]);

	const modelsWithCurrent = useMemo(() => {
		const output = [...models];
		if (value && !output.some(model => model.id === value)) {
			output.unshift({
				id: value,
				name: _('Current model: %s', value),
				contextLength: 0,
				isFree: false,
				pricingLabel: '',
			});
		}
		return output;
	}, [models, value]);

	const filteredModels = useMemo(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return modelsWithCurrent;
		return modelsWithCurrent.filter(model => {
			return [model.id, model.name, model.pricingLabel, model.isFree ? 'free' : ''].join(' ').toLowerCase().includes(query);
		});
	}, [modelsWithCurrent, searchQuery]);

	const selectedModel = modelsWithCurrent.find(model => model.id === value);
	const selectedLabel = selectedModel ? modelLabel(selectedModel) : value || _('Select a model');
	const modelKindLabel = settingId === 'threeR.llmModel3' ? _('Third') : settingId === 'threeR.llmModel2' ? _('Fallback') : _('Primary');

	const selectModel = useCallback((model: LlmModelOption) => {
		void updateSettingValue(settingId, model.id);
		setSelectorVisible(false);
	}, [settingId, updateSettingValue]);

	return (
		<View key={`${settingId}.${provider}`} style={containerStyles.outerContainer}>
			<View style={containerStyles.innerContainer}>
				<Text key="label" style={styleSheet.settingText}>
					{_('3R Reflect: %s LLM model', modelKindLabel)}
				</Text>
				<View style={localStyles.modelButtonWrapper}>
					<Button
						title={loading ? _('Loading...') : selectedModel ? selectedModel.name : _('Select a model')}
						onPress={() => setSelectorVisible(true)}
						disabled={loading || !modelsWithCurrent.length}
					/>
				</View>
			</View>
			<ScrollView horizontal style={localStyles.fullNameScroll}>
				<Text style={styleSheet.descriptionText}>{selectedLabel}</Text>
			</ScrollView>
			<Text style={styleSheet.settingDescriptionText}>
				{usesOpenRouter ? (
					loading ? _('Loading OpenRouter models...') : _('Fetched %d OpenRouter text models in real time. Free models are listed first.', models.length)
				) : usesGoogle ? _('Google Gemini models use the Gemini API key with the OpenAI-compatible endpoint.') : _('Cost-effective OpenAI multimodal models are listed first. Prices show input/output per 1M tokens.')}
			</Text>
			{error ? (
				<View style={{ paddingLeft: theme.marginLeft, paddingRight: theme.marginRight, paddingBottom: theme.marginBottom }}>
					<Text style={styleSheet.warningText}>{error}</Text>
					<Button title={_('Refresh OpenRouter models')} onPress={loadModels} />
				</View>
			) : null}
			<Modal visible={selectorVisible} transparent animationType="fade" onRequestClose={() => setSelectorVisible(false)}>
				<View style={localStyles.modalRoot}>
					<View style={[localStyles.modalPanel, { backgroundColor: theme.backgroundColor }]}>
						<TextInput
							style={[localStyles.searchInput, {
								borderColor: theme.dividerColor,
								color: theme.color,
								backgroundColor: theme.backgroundColor3 || theme.backgroundColor,
							}]}
							value={searchQuery}
							onChangeText={setSearchQuery}
							placeholder={_('Search models')}
							placeholderTextColor={theme.colorFaded}
							selectionColor={theme.textSelectionColor}
							cursorColor={theme.textSelectionColor}
							keyboardAppearance={theme.keyboardAppearance}
							autoCorrect={false}
							autoCapitalize="none"
						/>
						<FlatList
							data={filteredModels}
							keyExtractor={item => item.id}
							keyboardShouldPersistTaps="handled"
							renderItem={({ item }) => {
								const selected = item.id === value;
								return (
									<TouchableOpacity
										style={[localStyles.modelItem, {
											borderTopColor: theme.dividerColor,
											borderLeftColor: theme.color4,
											backgroundColor: selected ? theme.backgroundColor2 : theme.backgroundColor,
										}, selected && localStyles.modelItemSelected]}
										onPress={() => selectModel(item)}
									>
										<Text style={{ color: theme.color, fontSize: theme.fontSize }} numberOfLines={2}>{modelLabel(item)}</Text>
									</TouchableOpacity>
								);
							}}
							ListEmptyComponent={<Text style={[styleSheet.settingDescriptionText, { padding: 12 }]}>{_('No matching models')}</Text>}
						/>
						<View style={localStyles.modalFooter}>
							<Button title={_('Close')} onPress={() => setSelectorVisible(false)} />
						</View>
					</View>
				</View>
			</Modal>
		</View>
	);
};

export default OpenRouterModelSelector;

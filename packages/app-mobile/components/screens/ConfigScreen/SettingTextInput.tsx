import * as React from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import Setting, { AppType } from '@joplin/lib/models/Setting';
import { ConfigScreenStyles } from './configScreenStyles';
import { UpdateSettingValueCallback } from './types';
import { themeStyle } from '../../global-style';
import { FunctionComponent, ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { IconButton } from 'react-native-paper';
import { _ } from '@joplin/lib/locale';

interface Props {
	settingId: string;
	value: string;
	styles: ConfigScreenStyles;
	themeId: number;
	label: string;
	updateSettingValue: UpdateSettingValueCallback;
	description?: ReactNode;
}

const localStyles = StyleSheet.create({
	inputRow: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
	},
	input: {
		flex: 1,
	},
	clearButton: {
		margin: 0,
	},
});

const SettingTextInput: FunctionComponent<Props> = props => {
	const [valueState, setValueState] = useState(props.value);
	const md = Setting.settingMetadata(props.settingId);
	const themeId = props.themeId;
	const theme = themeStyle(themeId);
	const settingDescription = md.description ? md.description(AppType.Mobile) : '';
	const styleSheet = props.styles.styleSheet;
	const containerStyles = props.styles.getContainerStyle(!!settingDescription);
	const labelId = useId();
	const showClearButton = ['threeR.llmApiKey', 'threeR.llmApiKey2', 'threeR.llmApiKey3'].includes(props.settingId) && !!valueState;

	useEffect(() => {
		setValueState(props.value);
	}, [props.value]);

	const updateValue = useCallback((newValue: string) => {
		setValueState(newValue);
		void props.updateSettingValue(props.settingId, newValue);
	}, [props]);

	const clearValue = useCallback(() => {
		updateValue('');
	}, [updateValue]);

	return (
		<View key={props.settingId} style={containerStyles.outerContainer}>
			<View key={props.settingId} style={containerStyles.innerContainer}>
				<Text key="label" style={styleSheet.settingText} nativeID={labelId}>
					{md.label()}
				</Text>
				<View style={localStyles.inputRow}>
					<TextInput
						autoCorrect={false}
						autoComplete="off"
						selectionColor={theme.textSelectionColor}
						cursorColor={theme.textSelectionColor}
						keyboardAppearance={theme.keyboardAppearance}
						autoCapitalize="none"
						key="control"
						style={[styleSheet.settingControl, localStyles.input]}
						value={valueState}
						onChangeText={updateValue}
						secureTextEntry={!!md.secure}
						aria-labelledby={labelId}
					/>
					{showClearButton ? (
						<IconButton
							icon='close-circle'
							accessibilityLabel={_('Clear')}
							onPress={clearValue}
							style={localStyles.clearButton}
						/>
					) : null}
				</View>
			</View>
			{props.description}
		</View>
	);
};

export default SettingTextInput;

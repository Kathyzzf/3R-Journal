import * as React from 'react';
import SpeechToTextBanner from './SpeechToTextBanner';

interface Props {
	locale: string;
	onDismiss: ()=> void;
	onText: (text: string)=> void;
}

const VoiceTypingDialog: React.FC<Props> = props => {
	return <SpeechToTextBanner locale={props.locale} onText={props.onText} onDismiss={props.onDismiss}/>;
};

export default VoiceTypingDialog;

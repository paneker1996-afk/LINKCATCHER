const cliProgress = require("cli-progress");
const _colors = require("ansi-colors");
const { configure } = require('./configure');

exports.getProgress = () =>
	new cliProgress.SingleBar(
		{
			stopOnComplete: true,
			hideCursor: false,
			autopadding: true,
			fps: 5,
			barsize: configure.barSize,
		},
		{
			format: formatBar,
			barCompleteChar: "\u2588",
			barIncompleteChar: "\u2592",
		}
	);

function formatBar(optionsBar, paramsBar, payloadBar) {
	function autopadding(value, length) {
		return (optionsBar.autopaddingChar + value).slice(-length);
	}
	const completeSize = Math.round(paramsBar.progress * optionsBar.barsize);
	const incompleteSize = optionsBar.barsize - completeSize;
	const bar =
		optionsBar.barCompleteString.substr(0, completeSize) +
		optionsBar.barGlue +
		optionsBar.barIncompleteString.substr(0, incompleteSize);
	const percentage = Math.floor(paramsBar.progress * 100) + "";
	const stopTime = parseInt(Date.now());
	const elapsedTime = formatTime(Math.round(stopTime - paramsBar.startTime));

	var provider = payloadBar.provider == 'vimeo' ? "" : " " +
		_colors.white("|") +
		" " +
		autopadding(paramsBar.value, `${paramsBar.total}`.length) +
		`/${paramsBar.total}`;

	var payload = payloadBar.filename ? " " +
		_colors.white("|") +
		" Active files: " +
		`${payloadBar.filename}` : "";

	var barStr =
		_colors.white("|") +
		_colors.cyan(bar + " " + autopadding(percentage, 3) + "%") +
		" " +
		_colors.white("|") +
		" " +
		elapsedTime +
		provider +
		payload;
	return barStr;
}

function formatTime(value) {
	let s = String(Math.floor((value / 1000) % 60)).padStart(2, "0");
	let m = String(Math.floor((value / 1000 / 60) % 60)).padStart(2, "0");
	let h = String(Math.floor((value / (1000 * 60 * 60)) % 24)).padStart(2, "0");
	return h + ":" + m + ":" + s;
}

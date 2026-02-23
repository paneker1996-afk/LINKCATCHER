const readline = require("readline");
const _colors = require("ansi-colors");
const { configure } = require("./configure");

const findMaxIndex = function(arr) {
	let max = arr[0],
		maxIndex = 0;
	for (let i = 1, l = arr.length; i < l; i++) {
		const el = arr[i];
		if (el > max) {
			max = el;
			maxIndex = i;
		}
	}

	return maxIndex;
}

module.exports = {
	rl: readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	}),

	selectVideoQuality: (cfg, playlists, arr) => {
		const widthList = [];
		let arrays = [];
		const qualitiesOptions = playlists.map(({ attributes }, index) => {
			const { width, height } = attributes.RESOLUTION;
			widthList.push(width);
			let codec = attributes.CODECS ? `(${attributes.CODECS})` : "";
			return `${index}: ` + _colors.yellowBright(`${width}x${height} `.padStart(10, ` `)) + _colors.cyan(codec);
		});

		if (!cfg.manualVideoQuality) {
			let ind = findMaxIndex(widthList);
			arrays = [playlists[ind]["uri"], {}, playlists[ind].attributes.CODECS];
			if(arr){
				arrays.push( playlists[ind].segmments );
			}
			return arrays;
		}

		if (cfg.quality) {
			const selectedIndex = qualitiesOptions.indexOf(cfg.quality.label);
			if (selectedIndex === cfg.quality.index){
				arrays = [playlists[selectedIndex]["uri"], cfg.quality, playlists[selectedIndex].attributes.CODECS];
				if(arr){
					arrays.push( playlists[ind].segmments );
				}
				return arrays;
			}
		}
		console.log(`\u00A0`);
		console.log(`Выберите качество для видео: `.padStart(configure.padText) + _colors.yellowBright(`${cfg.title}`));
		console.log(`\u00A0`);
		for (let item of qualitiesOptions) console.log(item);

		return new Promise(resolve =>
			module.exports.rl.question("", answer => {
				let arrays = [];
				const index = Number.parseInt(answer);
				console.log(`\u00A0`);
				console.log(`Выбран вариант:`.padStart(configure.padText));
				console.log(qualitiesOptions[index]);
				arrays = [
					playlists[index]["uri"],
					{ index, label: qualitiesOptions[index] },
					playlists[index].attributes.CODECS
				];
				if(arr){
					arrays.push( playlists[index].segmments );
				}
				resolve(arrays);
			})
		);
	},
};

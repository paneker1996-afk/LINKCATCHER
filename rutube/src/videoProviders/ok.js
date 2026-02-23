const fetch = require("node-fetch");
const path = require("node:path");
const { getManifest } = require("../m3u8Utils");
const { selectVideoQuality } = require("../dialogue");
const URL = require("node:url");
const emojiStrip = require('emoji-strip');
const sanitize = require("sanitize-filename");
const { downloadFile } = require("../downloadFile");
const { uuid9 } = require("../uid");

const regex_ok = /^https:\/\/ok.ru\/(?:video|videoembed)\/(\d+)/;

module.exports = {
	mayUse: url => regex_ok.test(url),

	loadVideo: async cfg => {
		const regex = /<div\s+data-module="OKVideo".+data-options="(.+)"\s+data-player-container-id=/;

		const m = regex_ok.exec(cfg.url);
		const resp = await fetch(
			`https://ok.ru/videoembed/${m[1]}`
		);
		/**
		 * Если неверный статус
		 */
		if (!resp.ok) {
			throw new Error(
				`Не удалось загрузить информацию о видео: ${cfg.url}\r\n\r\n${resp.status} ${resp.statusText}`
			);
		}
		let text = await resp.textConverted();

		const _m = regex.exec(text);
		if(!_m){
			throw new Error(
				`Не удалось загрузить информацию о видео: ${cfg.url}\r\n\r\n${resp.status} ${resp.statusText}`
			);
		}
		const json = JSON.parse(_m[1].replace(/&quot;/g,'"'));
		const metadata = JSON.parse(json.flashvars.metadata);
		const url = metadata.hlsManifestUrl;

		let hlsUrl = URL.parse(url);

		cfg.title = sanitize(emojiStrip(cfg.title ?? (metadata.movie.title ?? uuid9()))).replace(/\s+/g, " ");
		const videoInfo = await getManifest(
			url,
			"Не удалось получить видео:"
		);

		process.title = "DOWNLOAD: " + cfg.title;

		const [m3u8, quality] = await selectVideoQuality(
			cfg,
			videoInfo["playlists"]
		);
		const urlPrefix = hlsUrl.protocol + "//" + hlsUrl.host;
		const segmentsUrl = urlPrefix + m3u8;
		// Получаем плейлист с сегментами
		const segmentsInfo = await getManifest(
			segmentsUrl,
			"Не удалось получить сегменты:"
		);
		const segmentsUrls = segmentsInfo.segments.map(
			segment => segmentsUrl + segment["uri"]
		);
		cfg.video = path.join(cfg.video, cfg.title);
		const name = await downloadFile(cfg, segmentsUrls);
		return [name, quality];
	}
}
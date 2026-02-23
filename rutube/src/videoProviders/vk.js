const URL = require("node:url");
const path = require("node:path");
const fetch = require("node-fetch");
const emojiStrip = require('emoji-strip');
const sanitize = require("sanitize-filename");
const { getManifest } = require("../m3u8Utils");
const { configure } = require("../configure");
const { selectVideoQuality } = require("../dialogue");
const { downloadFile } = require("../downloadFile");

/**
 * Видео от пользователя
 * https://vk.com/video643853031_456271286
 * https://vk.ru/video643853031_456271286
 * https://vkvideo.ru/video643853031_456271286
 * 
 * Видео от канала
 * https://vk.com/video-18255722_456244249
 * https://vk.ru/video-18255722_456244249
 * https://vkvideo.ru/video-18255722_456244249
 * 
 * Поддержка ссылки с плейлиста. Пример:
 * https://vkvideo.ru/playlist/62764098_2/video62764098_456239055
 * 
 */
const regexVk = /^https?:\/\/(?:vk|vkvideo)\.(?:ru|com)\/(?:playlist\/.+)?video(-?\d+_\d+)/;

const extractCookies = function(setCookie, cookies = {}, domain) {
	for (let pair of setCookie) {
		const res = cookieReg.exec(pair);
		const domainRes = cookieDomainReg.exec(pair);
		const cookieDomain = domainRes?.length > 0 ? domainRes[1] : domain;

		if (!cookies[cookieDomain]) cookies[cookieDomain] = {};

		if (res[2] === "DELETED") {
			delete cookies[cookieDomain][res[1]];
		} else {
			cookies[cookieDomain][res[1]] = res[2];
		}
	}
	return cookies;
}

const cookieReg = /([^=]+)=([^;]+)/;
const cookieDomainReg = /domain=([^;]+)/;

const encodeCookies = (c, domain) =>
	Object.entries(c[domain] ?? {})
		.map(([key, value]) => `${key}=${value}`)
		.join("; ");

const browserHeaders = configure.browserHeaders;

module.exports = {
	mayUse: url => regexVk.test(url),

	loadVideo: async cfg => {
		/**
		 * Обработать возможные ошибки в данной функции
		 * Здесь нет обработчиков.
		 */
		const getUrlResp = await fetch(cfg.url, {
			redirect: "manual",
			headers: browserHeaders,
		});
		const cookies = extractCookies(
			getUrlResp.headers.raw()["set-cookie"],
			{},
			".vkvideo.ru"
		);

		const autoLoginResp = await fetch(getUrlResp.headers.get("location"), {
			redirect: "manual",
			headers: browserHeaders,
		});
		extractCookies(
			autoLoginResp.headers.raw()["set-cookie"],
			cookies,
			".vk.com"
		);

		const anonymousLogin = await fetch(
			autoLoginResp.headers.get("location"),
			{
				redirect: "manual",
				headers: {
					...browserHeaders,
					Cookie: encodeCookies(cookies, ".vkvideo.ru"),
				},
			}
		);
		extractCookies(
			anonymousLogin.headers.raw()["set-cookie"],
			cookies,
			".vkvideo.ru"
		);

		const getPage = await fetch(anonymousLogin.headers.get("location"), {
			redirect: "manual",
			headers: {
				...browserHeaders,
				Cookie: encodeCookies(cookies, ".vkvideo.ru"),
			},
		});
		extractCookies(
			getPage.headers.raw()["set-cookie"],
			cookies,
			".vkvideo.ru"
		);

		const m = regexVk.exec(cfg.url);
		const body =
			"al=1&autoplay=1&claim=&force_no_repeat=true&is_video_page=true&list=&module=direct&show_next=1&video=" +
			m[1];

		const headers = {
			...browserHeaders,
			Cookie: encodeCookies(cookies, ".vkvideo.ru"),
			"content-type": "application/x-www-form-urlencoded",
			origin: "https://vkvideo.ru",
			referer: cfg.url,
			accept: "*/*",
		};

		const vkVideoInfo = await fetch(
			"https://vkvideo.ru/al_video.php?act=show",
			{
				method: "POST",
				redirect: "manual",
				headers,
				body,
			}
		);

		let text = await vkVideoInfo.textConverted();

		const json = JSON.parse(text.replace("<!--", ""));
		cfg.title = sanitize(emojiStrip(cfg.title ?? json.payload[1][0])).replace(/\s+/g, " ");

		const options = { headers };

		if(typeof json.payload[1][4].player != 'object') {
			throw new Error(
				`Не удалось загрузить информацию о видео: ${cfg.url}\r\n\r\n${ json.payload[1][0] }`
			);
		}

		const hlsUrl = json.payload[1][4].player.params[0].hls;
		const hls = await getManifest(
			hlsUrl,
			"Не удалось получить видео:",
			options
		);

		const [playlist, quality] = await selectVideoQuality(
			cfg,
			hls["playlists"]
		);

		const myURL = URL.parse(hlsUrl);
		const segmentsBase = URL.parse(myURL.protocol + "//" + myURL.host + playlist).href;

		const segmentsInfo = await getManifest(
			segmentsBase,
			"Не удалось получить сегменты:",
			options
		);

		const segmentsUrls = segmentsInfo["segments"].map(segment =>
			URL.parse(segmentsBase + segment["uri"]).href
		);
		cfg.video = path.join(cfg.video, cfg.title);
		
		const name = await downloadFile(cfg, segmentsUrls, options);
		return [name, quality];
	},
};

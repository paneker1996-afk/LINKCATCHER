const { exec } = require("node:child_process");

let path;


const probePath = path =>
	new Promise(resolve => {
		exec(`${path} -version`, err => {
			resolve(!err);
		});
	});

exports.execFFmpeg = async (input, output) => {
	if (!path) {
		path = "ffmpeg";
		if (!(await probePath(path))) {
			path = "../bin/ffmpeg";

			if (!(await probePath(path))) throw new Error("ffmpeg не найден");
		}
	}

	return new Promise((resolve, reject) => {
		const child = exec(
			`${path} -hide_banner -y -i "${input}" -vcodec copy -acodec copy "${output}"`
		);
		child.stdout.pipe(process.stdout);
		child.on("exit", code => {
			if (code) reject("ffmpeg error");
			else resolve(true);
		});
	});
};

const returnValue = v => () => v;

exports.parallelFor = async function (parallelNum, items, fn) {
	const parallels = [];
	const itemsLength = items.length;

	let index = 0;
	for (let i = 0; i < parallelNum; i++) {
		if (index < itemsLength) {
			parallels[i] = fn(items[index], index).then(returnValue(i));
			index++;
		}
	}

	while (index < itemsLength) {
		const i = await Promise.race(parallels);
		parallels[i] = fn(items[index], index).then(returnValue(i));
		index++;
	}

	return Promise.all(parallels);
};

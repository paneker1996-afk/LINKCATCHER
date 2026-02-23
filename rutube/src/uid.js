/**
 * Возвращает дату и время вызова функции
 * В нашем случае время начала работы с данными в момент запроса title для файла
 */
const allKeysBuilder = () => new Date().toLocaleString().replace(/\.|:/g, `-`).replace(/,\s+?/g, "_");

exports.uuid9 = allKeysBuilder;

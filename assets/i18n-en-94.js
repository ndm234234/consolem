// Английский прототипа 94 (docs/TEXTS.md, «Как менять текст безопасно»): подключён после assets/i18n-en.js
Object.assign(window.I18N_EN,{
"Поток включён":"Stream on",
"Параметры потоков и «Отправлять настройки устройству» консоль записывает на сервер. Если сервер не сообщает параметр потока, консоль показывает значение по умолчанию.":"The console writes the stream parameters and “Send settings to device” to the server. If the server does not send a stream parameter, the console shows the default value.",
"Прототип: у этой камеры нет объектов потоков. Кодек, битрейт, качество и опорный кадр консоль пока хранит только в этой странице. Разрешение, к/с и «Отправлять настройки устройству» консоль записывает на сервер.":"Prototype: this camera has no stream objects. The console keeps the codec, bitrate, quality and key frame only in this page for now. The console writes the resolution, fps and “Send settings to device” to the server.",
"Умный кодек":"Smart codec",
"умный кодек":"smart codec",
"Профиль потока камеры":"Camera stream profile",
"выбирает драйвер":"the driver selects",
"Если поток выключен, сервер не берёт его с камеры. Тогда у потока нет видео, записи и детекторов.":"If the stream is off, the server does not get it from the camera. Then the stream has no video, recording or detectors.",
"Режимы H.264+ и H.265+ уменьшают битрейт на спокойной сцене. Этот режим есть не у всех камер.":"The H.264+ and H.265+ modes decrease the bitrate on a quiet scene. Not all cameras have this mode.",
"Камера сама хранит кодек, битрейт, качество, опорный кадр, умный кодек, разрешение и к/с. Консоль изменит их, только когда включено «Отправлять настройки устройству».":"The camera itself keeps the codec, bitrate, quality, key frame, smart codec, resolution and fps. The console changes them only when “Send settings to device” is on.",
"Заглушка: команда defaults сообщает только разрешение и к/с потоков. Умолчания кодека и битрейта строит страница.":"Stub: the defaults command sends only the resolution and fps of the streams. The page makes the codec and bitrate defaults.",
"Заглушка: команда readConfig сообщает только разрешение и к/с потоков. Значения кодека, битрейта и параметров драйвера строит страница.":"Stub: the readConfig command sends only the resolution and fps of the streams. The page makes the codec, bitrate and driver parameter values."
});

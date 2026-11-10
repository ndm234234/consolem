// Английский прототипа 46 (docs/TEXTS.md, «Как менять текст безопасно»): подключён после assets/i18n-en.js
Object.assign(window.I18N_EN,{
// Новое имя переключателя (в index.html — «Push settings to device»)
"Отправлять настройки устройству":"Send settings to device",
// Карточка камеры после UX-критики: кнопки по смыслу, строка режима, вопрос при уходе, блоки «Подключения» по смыслу
"На этой вкладке вы не закончили правку блока":"You did not finish editing a block on this tab","Добавить в план":"Add to plan",
"Настройки самой камеры. Изменить их можно, когда включено «Отправлять настройки устройству».":"Settings of the camera itself. You can change them when “Send settings to device” is on.",
"Консоль показывает параметры потоков так, как их сообщила камера. У камеры RTSP их меняют в веб-интерфейсе камеры.":"The console shows the stream parameters that the camera reports. For an RTSP camera, change them in the camera web interface.",
"Блоки с замком содержат настройки самой камеры. Консоль показывает их так, как их сообщила камера, и не меняет их.":"Blocks with a lock contain settings of the camera itself. The console shows the values that the camera reports and does not change them.",
"Консоль не сохранила изменения камеры":"The console did not save the changes of the camera","в блоках:":"in these blocks:",
"Консоль запишет в камеру значения, которые показывает сейчас:":"The console will write to the camera the values that it shows now:",
"Консоль запишет и другие настройки в блоках с замком.":"The console will also write the other settings in the blocks with a lock.",
"Если кто-то изменит настройки в веб-интерфейсе камеры, консоль заменит их своими.":"If someone changes the settings in the camera web interface, the console will replace them with its own.",
"Выключить «Отправлять настройки устройству»?":"Turn off “Send settings to device”?","Консоль вернёт прежние значения этих блоков.":"The console will restore the previous values of these blocks.",
"Обмен с камерой":"Data exchange with camera","Изменения не сохранены":"Changes not saved","Сбросить и перейти":"Discard and go","Остаться":"Stay",
"Камера может перезапустить поток. Тогда видео и запись прервутся на несколько секунд.":"The camera can restart the stream. Then video and recording stop for a few seconds.",
"Включить «Отправлять настройки устройству»?":"Turn on “Send settings to device”?",
// Все правки окна камеры — через план: блоки драйвера, потоки, туры, «Сервер записи»
"«Сервер записи» и потоки консоль запишет отдельными запросами до операции. «Отменить» после применения их не вернёт.":"The console writes “Recording server” and the streams in separate requests before the operation. “Undo” after applying does not bring them back.",
"Прототип: параметры драйвера, кодек и битрейт потоков и туры живут только в этой странице. «Применить» оставит их как есть.":"Prototype: the driver parameters, the stream codec and bitrate and the tours exist only in this page. “Apply” keeps them as they are.",
"поток":"stream","разрешение":"resolution","прежний":"previous","изменён":"changed","будет добавлен":"will be added","будет удалён":"will be deleted","переменный":"variable","копий":"copies",
"Тур, когда камерой не управляют":"Tour when nobody controls the camera","Закрыть без правок?":"Close without the changes?",
"Консоль не добавит правки тура в план":"The console does not add the tour changes to the plan","Консоль добавила в план тур":"The console added to the plan the tour",
"после «Применить»":"after “Apply”","Консоль удалит поток":"The console will delete the stream",
"До «Применить» тур вернёт «Сбросить» внизу":"Until “Apply”, “Reset” at the bottom brings the tour back",
"До «Применить» поток вернут «Отменить» в блоке и «Сбросить» внизу":"Until “Apply”, “Cancel” in the block and “Reset” at the bottom bring the stream back",
"Итог будет в отчёте. «Отменить» после применения нет: на сервере нет операции, которую можно отменить.":"The result will be in the report. There is no “Undo” after applying: the server has no operation to undo.",
});

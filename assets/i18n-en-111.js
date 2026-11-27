// Английский прототипа 111 (docs/TEXTS.md, «Как менять текст безопасно»): подключён после assets/i18n-en.js
Object.assign(window.I18N_EN,{
"Как у детектора":"As at the detector",
"Свой":"Own",
"ширина":"width",
"высота":"height",
"Детектор не ограничивает размер объекта.":"The detector does not limit the object size.",
"Поддетектор получает объекты с размером детектора. Чтобы поддетектор пропускал только часть этих объектов, выбрать «Свой».":"The sub-detector gets the objects with the size of the detector. To make the sub-detector skip some of these objects, select «Own».",
"Поддетектор получает только объекты, которые нашёл детектор. Из них поддетектор не замечает объекты меньше и больше этих размеров. Консоль считает ширину и высоту в процентах кадра.":"The sub-detector gets only the objects that the detector found. Of these, the sub-detector ignores the objects that are smaller or larger than these sizes. The console calculates the width and the height as a percentage of the frame.",
"Поддетектор не замечает объекты меньше и больше этих размеров. Консоль считает ширину и высоту в процентах кадра.":"The sub-detector ignores the objects that are smaller or larger than these sizes. The console calculates the width and the height as a percentage of the frame.",
"Детектор находит объекты, а поддетектор решает, когда сработать. Зоны детектирования и размер объекта детектора действуют на все его поддетекторы. Свой размер поддетектора пропускает только часть объектов детектора.":"The detector finds the objects, and the sub-detector decides when to fire. The detection zones and the object size of the detector apply to all its sub-detectors. The own size of a sub-detector lets through only some of the objects of the detector."
});

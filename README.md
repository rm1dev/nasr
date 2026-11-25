# Mobile PWA Quran & Dua Sync

## Run locally

```bash
npx serve .
```

Then open the shown URL on mobile (or mobile emulator).

## Features

- Mobile-first PWA (`manifest.webmanifest` + `sw.js`)
- Theme based on `theme.jpg`
- Word-by-word Arabic highlight while audio is playing
- Persian translation under each Arabic line
- Tafsir note box under each line (stored in browser local storage)

## Text data source refresh

```bash
node scripts/build-data.mjs
```

This regenerates `data/tracks.json` from online sources.

## منابع مجموعهٔ ۹ آیه سفارش‌شده

- متن عثمانی حدید ۱ تا ۶ و حشر ۲۲ تا ۲۴ از پروژهٔ تنزیل است. بسم‌اللهِ آغاز سورهٔ حدید خارج از شمارش آیات و فایل تلاوت انتخابی است. Tanzil Quran Text, Copyright (C) 2007–2021 Tanzil Project, CC BY 3.0. [تنزیل](https://tanzil.net/) · [شرایط استفاده از متن](https://tanzil.net/docs/Text_License)
- ترجمهٔ فارسی از محمدمهدی فولادوند و نسخهٔ منتشرشده در تنزیل برای استفادهٔ غیرتجاری است. [ترجمه‌ها و شرایط استفاده](https://tanzil.net/trans/)
- فایل صوتی هر بخش از ضبط آیه‌به‌آیهٔ مشاری راشد العفاسی در EveryAyah ساخته شده است. مجوز بازنشر این ضبط هنوز تأیید نشده است. [منبع ضبط](https://everyayah.com/data/Alafasy_128kbps/)
- زمان‌بندی کلمات از دادهٔ Quran Align اثر Colin Fair با مجوز CC BY 4.0 است. زمان‌ها به ثانیه تبدیل شده‌اند و نسبت به ابتدای فایل صوتی هر بخش هستند. [انتشار داده](https://github.com/cpfair/quran-align/releases/tag/release-2016-11-24) · [مجوز](https://creativecommons.org/licenses/by/4.0/)

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from faster_whisper import WhisperModel

sys.stdout.reconfigure(encoding="utf-8")

SAMPLE_RATE = 16000


def parse_args():
    parser = argparse.ArgumentParser(
        description="Extract word-level timestamps from an audio file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""examples:
  python transcribe.py data/sounds/tavasol.mp3
  python transcribe.py data/sounds/fath.mp3 --language ar
  python transcribe.py data/sounds/sahife_sajadie_14.mp3 --language mixed
  python transcribe.py data/sounds/sahife_sajadie_14.mp3 --language mixed --pause 800
""",
    )
    parser.add_argument("audio", help="Path to audio file (e.g. data/sounds/tavasol.mp3)")
    parser.add_argument(
        "--language", "-l",
        default=None,
        help=(
            "Language code: 'ar', 'fa', etc. "
            "Use 'mixed' for alternating Arabic+Persian content. "
            "Default: auto-detect."
        ),
    )
    parser.add_argument(
        "--pause",
        type=int,
        default=2000,
        metavar="MS",
        help="Minimum silence duration in milliseconds to split segments (default: 2000).",
    )
    return parser.parse_args()


def split_by_word_gaps(whisper_words, gap_threshold_s):
    """Split a list of Word objects into groups wherever the gap between
    consecutive words exceeds gap_threshold_s."""
    if not whisper_words:
        return []
    groups = [[whisper_words[0]]]
    for w in whisper_words[1:]:
        if w.start - groups[-1][-1].end > gap_threshold_s:
            groups.append([])
        groups[-1].append(w)
    return groups


def transcribe_mixed(model, audio_path, vad_params):
    """Two-pass transcription for mixed Arabic+Persian content.

    Pass 1 (fast): detect VAD segment boundaries for the whole file.
    Pass 2: transcribe each chunk independently with language=None so
            Whisper detects the language from that short chunk alone.
    """
    from faster_whisper.audio import decode_audio

    print("  [mixed] Pass 1: detecting segment boundaries...", flush=True)
    boundary_gen, info = model.transcribe(
        str(audio_path),
        language=None,
        word_timestamps=False,
        beam_size=1,
        vad_filter=True,
        vad_parameters=vad_params,
        condition_on_previous_text=False,
    )
    boundaries = [(seg.start, seg.end) for seg in boundary_gen]
    print(f"  [mixed] {len(boundaries)} VAD segments found. Pass 2: per-segment transcription...", flush=True)

    audio = decode_audio(str(audio_path), sampling_rate=SAMPLE_RATE)

    segments = []
    for t0, t1 in boundaries:
        chunk = audio[int(t0 * SAMPLE_RATE) : int(t1 * SAMPLE_RATE)]
        if len(chunk) < int(0.1 * SAMPLE_RATE):
            continue

        # Each short chunk has its own language detection — much more accurate
        # than detecting on the first 30 s of the full file.
        seg_gen, chunk_info = model.transcribe(
            chunk,
            language=None,
            word_timestamps=True,
            beam_size=5,
            condition_on_previous_text=False,
        )
        seg_lang = chunk_info.language or "ar"

        for seg in seg_gen:
            words = []
            if seg.words:
                for w in seg.words:
                    words.append(SimpleNamespace(
                        word=w.word,
                        start=w.start + t0,
                        end=w.end + t0,
                    ))
            segments.append(SimpleNamespace(
                start=seg.start + t0,
                end=seg.end + t0,
                text=seg.text,
                words=words,
                language=seg_lang,
            ))

    return segments, info


def main():
    args = parse_args()
    audio_path = Path(args.audio)

    if not audio_path.exists():
        print(f"Error: file not found: {audio_path}")
        return

    out_path = audio_path.with_suffix(".json")
    mixed = args.language == "mixed"
    lang = None if mixed else args.language
    gap_threshold_s = args.pause / 1000
    vad_params = {"min_silence_duration_ms": args.pause}

    print(">>> Loading model...", flush=True)
    model = WhisperModel("large-v3", device="cpu", compute_type="int8")
    print(f">>> Processing {audio_path}  [language={args.language or 'auto'}, pause={args.pause}ms]", flush=True)

    if mixed:
        segments_list, info = transcribe_mixed(model, audio_path, vad_params)
        default_lang = info.language or "ar"
    else:
        seg_gen, info = model.transcribe(
            audio_path,
            language=lang,
            word_timestamps=True,
            beam_size=5,
            vad_filter=True,
            vad_parameters=vad_params,
        )
        segments_list = list(seg_gen)
        default_lang = info.language or lang or "ar"

    result = []

    for seg in segments_list:
        seg_lang = getattr(seg, "language", None) or default_lang

        if not seg.words:
            result.append({
                "language": seg_lang,
                "text": seg.text.strip(),
                "translation": None,
                "tafsir": None,
                "words": [],
            })
            print(f"  [{seg.start:.1f}s -> {seg.end:.1f}s] [{seg_lang}] {seg.text.strip()}", flush=True)
            continue

        groups = split_by_word_gaps(seg.words, gap_threshold_s)
        for group in groups:
            text = "".join(w.word for w in group).strip()
            words = [{"start": round(w.start, 3), "end": round(w.end, 3)} for w in group]
            t0, t1 = group[0].start, group[-1].end
            result.append({
                "language": seg_lang,
                "text": text,
                "translation": None,
                "tafsir": None,
                "words": words,
            })
            split_marker = " [split]" if len(groups) > 1 else ""
            print(f"  [{t0:.1f}s -> {t1:.1f}s] [{seg_lang}]{split_marker} {text}", flush=True)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\n>>> Saved: {out_path}", flush=True)
    print(f"    Duration: {info.duration:.1f}s  |  Detected language: {info.language}", flush=True)


if __name__ == "__main__":
    main()

"""
align_timestamps.py
-------------------
Given a JSON file with correct Arabic text (and empty "words" arrays),
uses Whisper to extract word-level timestamps and aligns them to the
known text via sequence alignment (edit-distance DP).

Usage:
  python align_timestamps.py data/sounds/tavasol.json data/sounds/tavasol.mp3
  python align_timestamps.py data/sounds/tavasol.json data/sounds/tavasol.mp3 --language ar
  python align_timestamps.py data/sounds/tavasol.json data/sounds/tavasol.mp3 --model medium
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import List, Optional

# ── Arabic normalisation ────────────────────────────────────────────────────

_DIACRITICS = re.compile(
    r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]"
)
_PUNCT = re.compile(r"[.,،؛؟!؟\-–—\"\'«»]")
_TATWEEL = re.compile(r"\u0640+")          # kashida
_ALEF_VARIANTS = re.compile(r"[أإآٱ]")    # normalise alef variants → ا


def normalise(word: str) -> str:
    word = _DIACRITICS.sub("", word)
    word = _TATWEEL.sub("", word)
    word = _PUNCT.sub("", word)
    word = _ALEF_VARIANTS.sub("ا", word)
    word = word.replace("ة", "ه")         # ta-marbuta → ha
    word = word.replace("ى", "ي")         # alef-maqsura → ya
    return word.strip()


# ── Sequence alignment (DP) ─────────────────────────────────────────────────

def _char_sim(a: str, b: str) -> float:
    """Normalised character overlap similarity [0..1]."""
    if not a or not b:
        return 0.0
    common = sum((min(a.count(c), b.count(c)) for c in set(a)), 0)
    return 2 * common / (len(a) + len(b))


def align(ref_words: List[str], hyp_words: List[str]) -> List[Optional[int]]:
    """
    Align ref_words (from JSON) to hyp_words (from Whisper).
    Returns a list of length len(ref_words):
        result[i] = index into hyp_words matched to ref_words[i], or None.
    Uses a simple DP that maximises total similarity while preserving order.
    """
    R, H = len(ref_words), len(hyp_words)
    # dp[i][j] = best score when ref[:i] aligned against hyp[:j]
    NEG_INF = float("-inf")
    dp = [[NEG_INF] * (H + 1) for _ in range(R + 1)]
    choice: List[List[Optional[str]]] = [[None] * (H + 1) for _ in range(R + 1)]  # 'm' match, 'sr' skip-ref, 'sh' skip-hyp
    dp[0][0] = 0.0
    for j in range(1, H + 1):
        dp[0][j] = 0.0          # skip hyp words at no cost
        choice[0][j] = "sh"

    for i in range(1, R + 1):
        for j in range(1, H + 1):
            # option 1: match ref[i-1] with hyp[j-1]
            sim = _char_sim(ref_words[i - 1], hyp_words[j - 1])
            score_match = dp[i - 1][j - 1] + sim

            # option 2: skip ref word (no timestamp)
            score_skip_ref = dp[i - 1][j] - 0.3

            # option 3: skip hyp word
            score_skip_hyp = dp[i][j - 1] - 0.05

            best = max(score_match, score_skip_ref, score_skip_hyp)
            dp[i][j] = best
            if best == score_match:
                choice[i][j] = "m"
            elif best == score_skip_ref:
                choice[i][j] = "sr"
            else:
                choice[i][j] = "sh"

    # traceback
    result: List[Optional[int]] = [None] * R
    i, j = R, H
    while i > 0 and j > 0:
        c = choice[i][j]
        if c == "m":
            result[i - 1] = j - 1
            i -= 1; j -= 1
        elif c == "sr":
            i -= 1
        else:
            j -= 1

    return result


# ── Main ────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="Align Whisper word timestamps to a pre-written JSON.")
    p.add_argument("json_file", help="Path to JSON with correct text and empty words arrays")
    p.add_argument("audio_file", help="Path to the corresponding MP3/WAV")
    p.add_argument("--language", "-l", default="ar",
                   help="Whisper language code (default: ar). Use 'mixed' for alternating Arabic+Persian content.")
    p.add_argument("--model", "-m", default="large-v3", help="Whisper model size (default: large-v3)")
    p.add_argument("--device", default="cpu", help="Device: cpu or cuda (default: cpu)")
    return p.parse_args()


def main():
    args = parse_args()
    json_path = Path(args.json_file)
    audio_path = Path(args.audio_file)

    if not json_path.exists():
        sys.exit(f"Error: JSON not found: {json_path}")
    if not audio_path.exists():
        sys.exit(f"Error: audio not found: {audio_path}")

    # ── Load JSON ──────────────────────────────────────────────────────────
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    # Collect flat list of (verse_idx, word_idx, raw_word, normalised)
    json_flat = []
    for vi, verse in enumerate(data):
        tokens = verse.get("text", "").split()
        for wi, tok in enumerate(tokens):
            json_flat.append({"vi": vi, "wi": wi, "raw": tok, "norm": normalise(tok)})

    print(f">>> JSON: {len(data)} verses, {len(json_flat)} words total")

    # ── Whisper transcription ──────────────────────────────────────────────
    print(f">>> Loading Whisper model '{args.model}' …")
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device=args.device, compute_type="int8")

    mixed = args.language == "mixed"
    lang = None if mixed else args.language

    print(f">>> Transcribing {audio_path} …")

    if mixed:
        from types import SimpleNamespace
        from faster_whisper.audio import decode_audio

        print("  [mixed] Pass 1: detecting segment boundaries …", flush=True)
        boundary_gen, info = model.transcribe(
            str(audio_path),
            language=None,
            word_timestamps=False,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        boundaries = [(seg.start, seg.end) for seg in boundary_gen]
        print(f"  [mixed] {len(boundaries)} VAD segments found. Pass 2: per-segment transcription …", flush=True)

        SAMPLE_RATE = 16000
        audio = decode_audio(str(audio_path), sampling_rate=SAMPLE_RATE)

        all_segments = []
        for t0, t1 in boundaries:
            chunk = audio[int(t0 * SAMPLE_RATE): int(t1 * SAMPLE_RATE)]
            if len(chunk) < int(0.1 * SAMPLE_RATE):
                continue
            seg_gen, chunk_info = model.transcribe(
                chunk,
                language=None,
                word_timestamps=True,
                beam_size=5,
                condition_on_previous_text=False,
            )
            for seg in seg_gen:
                words = []
                if seg.words:
                    for w in seg.words:
                        words.append(SimpleNamespace(
                            word=w.word,
                            start=w.start + t0,
                            end=w.end + t0,
                        ))
                all_segments.append(SimpleNamespace(words=words))
    else:
        seg_gen, info = model.transcribe(
            str(audio_path),
            language=lang,
            word_timestamps=True,
            beam_size=5,
            vad_filter=True,
        )
        all_segments = list(seg_gen)

    whisper_flat = []          # (norm, start, end)
    for seg in all_segments:
        if seg.words:
            for w in seg.words:
                whisper_flat.append({
                    "raw": w.word,
                    "norm": normalise(w.word),
                    "start": w.start,
                    "end": w.end,
                })

    print(f">>> Whisper: {len(whisper_flat)} words detected")

    # ── Alignment ─────────────────────────────────────────────────────────
    print(">>> Aligning …")
    ref_norms = [w["norm"] for w in json_flat]
    hyp_norms = [w["norm"] for w in whisper_flat]
    mapping = align(ref_norms, hyp_norms)   # mapping[i] = j or None

    matched = sum(1 for x in mapping if x is not None)
    print(f">>> Matched {matched}/{len(json_flat)} words")

    # Assign timestamps back to json_flat entries
    for i, j in enumerate(mapping):
        if j is not None:
            json_flat[i]["start"] = whisper_flat[j]["start"]
            json_flat[i]["end"] = whisper_flat[j]["end"]

    # ── Fill in verse words arrays ─────────────────────────────────────────
    # Group by verse
    from collections import defaultdict
    by_verse = defaultdict(list)
    for entry in json_flat:
        by_verse[entry["vi"]].append(entry)

    for vi, verse in enumerate(data):
        entries = by_verse.get(vi, [])
        words_with_time = [e for e in entries if "start" in e]

        # If some words are missing timestamps, interpolate gaps
        if words_with_time:
            # Fill leading gap: use start of first matched word
            first_t = words_with_time[0]["start"]
            last_t = words_with_time[-1]["end"]

            timestamps = []
            for e in entries:
                if "start" in e:
                    timestamps.append({"start": round(e["start"], 3), "end": round(e["end"], 3)})
                else:
                    # interpolate: place between neighbours
                    timestamps.append(None)

            # Simple linear fill for None gaps
            i = 0
            while i < len(timestamps):
                if timestamps[i] is None:
                    # find prev and next known
                    prev_end = timestamps[i - 1]["end"] if i > 0 and timestamps[i - 1] else first_t
                    j = i + 1
                    while j < len(timestamps) and timestamps[j] is None:
                        j += 1
                    next_start = timestamps[j]["start"] if j < len(timestamps) and timestamps[j] else last_t
                    gap = j - i
                    step = (next_start - prev_end) / (gap + 1)
                    for k in range(gap):
                        s = round(prev_end + step * (k + 1), 3)
                        e2 = round(prev_end + step * (k + 2), 3)
                        timestamps[i + k] = {"start": s, "end": e2}
                    i = j
                else:
                    i += 1

            verse["words"] = timestamps
        else:
            verse["words"] = []

    # ── Save ──────────────────────────────────────────────────────────────
    out_path = json_path  # overwrite in place
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n>>> Done! Saved: {out_path}")
    print(f"    Audio duration: {info.duration:.1f}s")

    # Print summary per verse
    print("\n── Verse summary ──────────────────────────────────────────────")
    for vi, verse in enumerate(data):
        n_total = len(verse["text"].split())
        n_timed = sum(1 for w in verse["words"] if w)
        status = "✓" if n_timed == n_total else f"~{n_timed}/{n_total}"
        preview = verse["text"][:50]
        print(f"  verse {vi:2d}  [{status}]  {preview}")


if __name__ == "__main__":
    main()

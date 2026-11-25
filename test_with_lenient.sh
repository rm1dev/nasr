#!/bin/bash
# Test script to run alignment with --lenient flag and capture debug output

echo "=========================================="
echo "Testing Whisper with --lenient flag"
echo "=========================================="
echo ""
echo "This will:"
echo "  1. Disable VAD filtering"
echo "  2. Lower no_speech_threshold to 0.2"
echo "  3. Show detailed repetition detection debug output"
echo ""
echo "Running..."
echo ""

# Backup the current fath.json
cp data/sounds/fath.json data/sounds/fath.json.backup

# Run with lenient mode
.venv_whisper/bin/python align_timestamps.py \
    data/sounds/fath.json \
    data/sounds/fath.mp3 \
    --lenient \
    2>&1 | tee alignment_debug_output.txt

echo ""
echo "=========================================="
echo "Done!"
echo "=========================================="
echo ""
echo "Output saved to: alignment_debug_output.txt"
echo "Backup saved to: data/sounds/fath.json.backup"
echo ""
echo "To see just the repetition detection debug:"
echo "  grep -A 200 'REPETITION DETECTION' alignment_debug_output.txt"
echo ""
echo "To restore the backup:"
echo "  cp data/sounds/fath.json.backup data/sounds/fath.json"

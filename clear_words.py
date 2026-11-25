import json
import sys

if len(sys.argv) != 2:
    print("Usage: python clear_words.py <file.json>")
    sys.exit(1)

path = sys.argv[1]

with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

for item in data:
    if "words" in item:
        item["words"] = []

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"Done. {len(data)} items processed.")

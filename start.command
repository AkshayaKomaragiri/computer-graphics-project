#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Mars Atlas needs Python 3. Install it from https://www.python.org/downloads/ and run this launcher again."
  printf "Press Return to close: "
  read -r answer
  exit 1
fi
python3 start.py

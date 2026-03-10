# Third-Party Notices

This file contains notices for third-party software whose code or design patterns were incorporated into this project.

---

## Recursive Language Models (RLM)

The recall module (`src/extension/recall/`) is based on the RLM framework.

- **Source**: https://github.com/alexzhang13/rlm
- **Paper**: arXiv 2512.24601v2 — "Recursive Language Models"
- **Ported patterns**: REPL iteration loop, FINAL/FINAL_VAR protocol, code block extraction, system prompt structure, sub-call architecture

```
MIT License

Copyright (c) 2025 Alex Zhang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

# Ask RyeGuru

Ask RyeGuru is the source-grounded chat endpoint for the RYE corpus.

## Environment

Set these variables on the deployment service:

- `OPENAI_API_KEY` — OpenAI API key; keep it server-side and never put it in the HTML.
- `OPENAI_MODEL` — optional; defaults to `gpt-5.6-luna`.

## Endpoint

`POST /chat`

Body:

```json
{
  "question": "De ce este lipicios aluatul de secară?",
  "history": []
}
```

The endpoint first retrieves evidence from the local RYE SQLite corpus, then asks the configured model to answer only from that evidence. It returns the answer and the evidence records used.

## RYE policy

The prompt explicitly forbids filling missing information with general knowledge, inventing recipes or process parameters, and reconciling conflicting sources automatically. When the retrieved evidence does not support an answer, the assistant must say:

`Nu este documentat în sursele RYE disponibile.`

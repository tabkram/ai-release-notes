# API Key Setup Guides

`ai-release-notes` reads credentials from environment variables. Never add API keys to `.ai-release-notes.yml` or commit them to your repository.

## OpenAI

1. Go to [platform.openai.com](https://platform.openai.com) and sign in.
2. Add a payment method under **Settings > Billing**, if required.
3. Open [API Keys](https://platform.openai.com/api-keys) and select **Create new secret key**.
4. Copy the key when it is shown, then set it:

   ```bash
   export OPENAI_API_KEY=sk-...
   ```

## Anthropic (Claude)

1. Go to [console.anthropic.com](https://console.anthropic.com) and sign in.
2. Select **API Keys** in the sidebar, then **Create Key**.
3. Name and copy the key, then set it:

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

See the [Anthropic getting-started guide](https://docs.anthropic.com/en/api/getting-started) for account and billing details.

## Mistral

1. Go to [console.mistral.ai](https://console.mistral.ai) and sign in.
2. Select **API Keys**, then **Create API Key**.
3. Copy the key, then set it:

   ```bash
   export MISTRAL_API_KEY=...
   ```

See the [Mistral quickstart](https://docs.mistral.ai/getting-started/quickstart/) for details.

## Google (Gemini)

1. Open [Google AI Studio](https://aistudio.google.com) and sign in.
2. Select **Get API Key**, choose or create a Google Cloud project, and select **Create API Key**.
3. Copy the key, then set it:

   ```bash
   export GOOGLE_API_KEY=...
   ```

See the [Gemini API getting-started guide](https://ai.google.dev/gemini-api/docs/get-started) for current authorization requirements.

## Azure OpenAI

1. In the [Azure portal](https://portal.azure.com), create an **Azure OpenAI** resource.
2. After deployment, open **Keys and Endpoint** and copy either key and the endpoint.
3. Set both values:

   ```bash
   export AZURE_OPENAI_API_KEY=...
   export AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
   ```

See [Create and deploy an Azure OpenAI resource](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/create-resource) for details.

## Ollama

Local Ollama needs no API key.

1. [Install Ollama](https://ollama.com/download).
2. Pull a model, for example: `ollama pull llama3.1`.
3. Start Ollama (the default address is `http://localhost:11434`) and use `--with ollama`.

For hosted Ollama Cloud, set `OLLAMA_API_KEY` as provided by the service. See the [Ollama documentation](https://github.com/ollama/ollama).

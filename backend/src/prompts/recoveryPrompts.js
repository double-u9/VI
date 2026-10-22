/**
 * Self-Correction & JSON Recovery Prompts
 * Used for automated syntax repair when the model outputs malformed DB_ACTION blocks.
 */

function buildJsonRepairPrompt(malformedSnippet, errorMessage) {
    return [
        {
            role: "system",
            content: `You are a strict JSON repair utility. Fix the malformed JSON for a wallet database action.
The action must adhere to one of these schemas:
TRANSFER:
{"action": "TRANSFER", "recipient": "<Name>", "amount": <number>, "phone": "<Phone>"}
BILL_PAYMENT:
{"action": "BILL_PAYMENT", "bill_id": "<Bill ID or 'ALL'>", "biller": "<Biller name>", "amount": <number>, "account_number": "<Account number>"}
ADD_CONTACT:
{"action": "ADD_CONTACT", "name": "<Name>", "alias": "<Name>", "phone": "<Phone>", "wallet_provider": "VI"}

Output ONLY valid, parseable raw JSON. Do NOT include markdown blocks, quotes around the json, or explanatory text.`
        },
        {
            role: "user",
            content: `Malformed JSON snippet:
${malformedSnippet}

Parser Error:
${errorMessage}

Return the corrected valid JSON object only:`
        }
    ];
}

module.exports = {
    buildJsonRepairPrompt
};

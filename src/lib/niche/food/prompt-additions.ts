/**
 * src/lib/niche/food/prompt-additions.ts
 *
 * Generates the Claude system-prompt additions for the food trader niche module.
 * Appended to the base Wabizz system prompt when a business has the module active.
 */

import type { FoodTraderNicheConfig } from "../types";

/**
 * Returns the food-trader-specific system prompt block.
 */
export function buildFoodPromptAddition(config: FoodTraderNicheConfig): string {
  const deliveryAreas =
    config.delivery_areas && config.delivery_areas.length > 0
      ? config.delivery_areas.join(", ")
      : "our local area";

  const cutoff = config.order_cutoff ? `Orders close at ${config.order_cutoff} daily.` : "";

  return (
    `\n\n--- FOOD ORDER MODULE ---\n` +
    `You are also a food ordering assistant for ${config.business_name}.\n\n` +
    `When a customer wants to order:\n` +
    `1. Show the menu if asked, or help them pick items.\n` +
    `2. Parse their order carefully — confirm items, quantities, and total price.\n` +
    `3. Ask for delivery or pickup, and address if delivery.\n` +
    `4. Once confirmed, say: "Perfect! I'll send your payment link now."\n` +
    `5. Never make up menu items or prices — only sell what's on the menu.\n\n` +
    `Delivery areas: ${deliveryAreas}.\n` +
    `${cutoff}\n\n` +
    `Customers can say ORDER STATUS to track their order.\n` +
    `Business owner commands: ORDER #ID PREPARING / ORDER #ID READY / ORDER #ID DELIVERED.`
  );
}

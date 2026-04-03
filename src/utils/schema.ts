import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

/**
 * Converts a JSON Schema object to a Zod schema
 */
function jsonSchemaToZod(schema: {
  type: string;
  properties: Record<string, any>;
  required?: string[];
}): z.ZodSchema {
  const requiredFields = new Set(schema.required || []);
  const properties: Record<string, z.ZodTypeAny> = {};
  
  for (const [key, value] of Object.entries(schema.properties)) {
    let fieldSchema: z.ZodTypeAny;
    
    switch (value.type) {
      case 'string':
        fieldSchema = value.enum ? z.enum(value.enum) : z.string();
        break;
      case 'number':
        fieldSchema = z.number();
        break;
      case 'boolean':
        fieldSchema = z.boolean();
        break;
      case 'array':
        if (value.items.type === 'string') {
          fieldSchema = z.array(z.string());
        } else {
          fieldSchema = z.array(z.unknown());
        }
        break;
      case 'object':
        if (value.properties) {
          fieldSchema = jsonSchemaToZod(value);
        } else {
          fieldSchema = z.record(z.unknown());
        }
        break;
      default:
        fieldSchema = z.unknown();
    }

    // Add description if present
    if (value.description) {
      fieldSchema = fieldSchema.describe(value.description);
    }

    // Make field optional if it's not required
    properties[key] = requiredFields.has(key) ? fieldSchema : fieldSchema.optional();
  }
  
  return z.object(properties);
}

/**
 * Creates a tool schema handler from an existing JSON Schema
 */
export function createSchemaHandlerFromJson<T = any>(jsonSchema: {
  type: string;
  properties: Record<string, any>;
  required?: string[];
}) {
  const zodSchema = jsonSchemaToZod(jsonSchema);
  return createSchemaHandler(zodSchema);
}

/**
 * Creates a tool schema handler that manages both JSON Schema for MCP and Zod validation
 */
export function createSchemaHandler<T>(schema: z.ZodSchema<T>) {
  return {
    // Convert to JSON Schema for MCP interface
    jsonSchema: (() => {
      const fullSchema = zodToJsonSchema(schema) as Record<string, any>;
      
      // Handle union/discriminatedUnion schemas (anyOf/oneOf)
      // Merge properties from all variants into a flat schema for MCP clients
      if (fullSchema.anyOf || fullSchema.oneOf) {
        const variants = (fullSchema.anyOf || fullSchema.oneOf) as Array<Record<string, any>>;
        const mergedProperties: Record<string, any> = {};
        const requiredSets: Set<string>[] = [];
        
        for (const variant of variants) {
          if (variant.properties) {
            for (const [key, value] of Object.entries(variant.properties)) {
              if (!mergedProperties[key]) {
                mergedProperties[key] = { ...value as Record<string, any> };
              } else {
                // Merge enum values for discriminator fields
                const existing = mergedProperties[key];
                const incoming = value as Record<string, any>;
                if (existing.const && incoming.enum) {
                  mergedProperties[key] = { type: "string", enum: [existing.const, ...incoming.enum] };
                } else if (incoming.const && existing.enum) {
                  mergedProperties[key] = { type: "string", enum: [...existing.enum, incoming.const] };
                } else if (existing.const && incoming.const) {
                  mergedProperties[key] = { type: "string", enum: [existing.const, incoming.const] };
                }
              }
            }
          }
          if (variant.required) {
            requiredSets.push(new Set(variant.required as string[]));
          }
        }
        
        // Required fields = intersection of all variants' required fields
        const commonRequired = requiredSets.length > 0
          ? [...requiredSets[0]].filter(field => requiredSets.every(s => s.has(field)))
          : [];
        
        // Handle "not":{} entries (z.undefined() artifacts from discriminated unions)
        // If a property exists as "not":{} in one variant but has a real type in another,
        // keep the real type version. Only remove if ALL variants say "not":{}.
        for (const [key, value] of Object.entries(mergedProperties)) {
          if (value && typeof value === 'object' && 'not' in value) {
            // Check if any variant has a real definition for this property
            let hasRealDef = false;
            for (const variant of variants) {
              const prop = variant.properties?.[key];
              if (prop && !('not' in prop) && prop.type) {
                mergedProperties[key] = { ...prop };
                hasRealDef = true;
                break;
              }
            }
            if (!hasRealDef) {
              delete mergedProperties[key];
            }
          }
        }
        
        return {
          type: "object",
          properties: mergedProperties,
          required: commonRequired
        };
      }
      
      return {
        type: fullSchema.type || "object",
        properties: fullSchema.properties || {},
        required: fullSchema.required || []
      };
    })(),
    
    // Validate and parse input
    parse: (input: unknown): T => {
      try {
        return schema.parse(input);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid arguments: ${error.errors.map(e => e.message).join(", ")}`
          );
        }
        throw error;
      }
    }
  };
}

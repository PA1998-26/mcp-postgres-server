#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
const { Client } = pg;
import { config } from 'dotenv';


// Load environment variables
config();

// Debug: Log all environment variables that start with PG_
const pgEnvVars = Object.fromEntries(
  Object.keys(process.env)
    .filter((key) => key.startsWith('PG_'))
    .map((key) => [key, process.env[key] ? '***' : 'undefined'])
);
console.log('[MCP Debug] All PG_ environment variables:', pgEnvVars);

interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

// Type guard for error objects
function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

// Helper to get error message
function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

// Helper to convert ? parameters to $1, $2, etc.
function convertToNamedParams(query: string): string {
  let paramIndex = 0;
  return query.replace(/\?/g, () => `$${++paramIndex}`);
}

class PostgresServer {
  private server: Server;
  private client: pg.Client | null = null;
  private config: DatabaseConfig | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'postgres-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Check environment variables on startup
    console.log('[MCP] Server starting up...');
    const envConfig = this.getEnvConfig();
    if (envConfig) {
      console.log('[MCP] Environment variables loaded successfully on startup');
    } else {
      console.log('[MCP] No environment variables found - manual connection required');
    }

    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    const handleTermination = async () => {
      try {
        await this.cleanup();
      } catch (error) {
        console.error('Error during cleanup:', error);
        process.exit(1);
      }
      process.exit(0);
    };
    process.on('SIGINT', handleTermination);
    process.stdin.on('close', handleTermination);
  }

  private async cleanup() {
    if (this.client) {
      await this.client.end();
    }
    await this.server.close();
  }

  private async ensureConnection() {
    if (!this.config) {
      // Try to use environment variables if no explicit config was provided
      const envConfig = this.getEnvConfig();
      
      if (envConfig) {
        this.config = envConfig;
        console.error('[MCP Info] Using database config from environment variables');
      } else {
        throw new McpError(
          ErrorCode.InvalidRequest,
          'Database configuration not set. Use connect_db tool first or set environment variables.'
        );
      }
    }

    if (!this.client) {
      try {
        this.client = new Client(this.config);
        await this.client.connect();
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to connect to database: ${getErrorMessage(error)}`
        );
      }
    }
  }
  
  private getEnvConfig(): DatabaseConfig | null {
    const { PG_HOST, PG_USER, PG_PASSWORD, PG_DATABASE, PG_PORT, PG_SSL, PGSSLMODE } = process.env;
    
    // Debug logging
    console.log('[MCP Debug] Environment variables check:', {
      PG_HOST: PG_HOST ? '***' : 'undefined',
      PG_USER: PG_USER ? '***' : 'undefined', 
      PG_PASSWORD: PG_PASSWORD ? '***' : 'undefined',
      PG_DATABASE: PG_DATABASE ? '***' : 'undefined',
      PG_PORT: PG_PORT || 'undefined',
      PG_SSL: PG_SSL || 'undefined',
      PGSSLMODE: PGSSLMODE || 'undefined'
    });
    
    if (PG_HOST && PG_USER && PG_PASSWORD && PG_DATABASE) {
      const config: DatabaseConfig = {
        host: PG_HOST,
        port: PG_PORT ? parseInt(PG_PORT, 10) : 5432,
        user: PG_USER,
        password: PG_PASSWORD,
        database: PG_DATABASE
      };
      
      // Handle SSL configuration - support both PG_SSL and PGSSLMODE
      if (PG_SSL !== undefined) {
        if (PG_SSL.toLowerCase() === 'true' || PG_SSL === '1') {
          config.ssl = true;
        } else if (PG_SSL.toLowerCase() === 'false' || PG_SSL === '0') {
          config.ssl = false;
        } else if (PG_SSL.toLowerCase() === 'reject-unauthorized-false') {
          config.ssl = { rejectUnauthorized: false };
        }
      } else if (PGSSLMODE !== undefined) {
        // Handle PGSSLMODE values
        if (PGSSLMODE.toLowerCase() === 'require' || PGSSLMODE.toLowerCase() === 'prefer') {
          config.ssl = { rejectUnauthorized: false };
        } else if (PGSSLMODE.toLowerCase() === 'disable') {
          config.ssl = false;
        } else {
          config.ssl = { rejectUnauthorized: false };
        }
      } else {
        // Default SSL configuration for production environments
        config.ssl = { rejectUnauthorized: false };
      }
      
      console.log('[MCP Debug] Environment config loaded successfully');
      return config;
    }
    
    console.log('[MCP Debug] Missing required environment variables');
    return null;
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'connect_db',
          description: 'Connect to PostgreSQL database. NOTE: Default connection exists - only use when requested or if other commands fail',
          inputSchema: {
            type: 'object',
            properties: {
              host: {
                type: 'string',
                description: 'Database host',
              },
              port: {
                type: 'number',
                description: 'Database port (default: 5432)',
              },
              user: {
                type: 'string',
                description: 'Database user',
              },
              password: {
                type: 'string',
                description: 'Database password',
              },
              database: {
                type: 'string',
                description: 'Database name',
              },
              ssl: {
                type: ['boolean', 'object'],
                description: 'SSL configuration. Use false to disable SSL, true to enable with default settings, or { rejectUnauthorized: false } to disable certificate verification (recommended for cloud databases)',
              },
            },
            required: ['host', 'user', 'password', 'database'],
          },
        },
        {
          name: 'query',
          description: 'Execute a SELECT query',
          inputSchema: {
            type: 'object',
            properties: {
              sql: {
                type: 'string',
                description: 'SQL SELECT query (use $1, $2, etc. for parameters)',
              },
              params: {
                type: 'array',
                items: {
                  type: ['string', 'number', 'boolean', 'null'],
                },
                description: 'Query parameters (optional)',
              },
            },
            required: ['sql'],
          },
        },
        {
          name: 'execute',
          description: 'Execute an INSERT, UPDATE, or DELETE query',
          inputSchema: {
            type: 'object',
            properties: {
              sql: {
                type: 'string',
                description: 'SQL query (INSERT, UPDATE, DELETE) (use $1, $2, etc. for parameters)',
              },
              params: {
                type: 'array',
                items: {
                  type: ['string', 'number', 'boolean', 'null'],
                },
                description: 'Query parameters (optional)',
              },
            },
            required: ['sql'],
          },
        },
        {
          name: 'list_schemas',
          description: 'List all schemas in the database',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'list_tables',
          description: 'List tables in the database',
          inputSchema: {
            type: 'object',
            properties: {
              schema: {
                type: 'string',
                description: 'Schema name (default: public)',
              },
            },
            required: [],
          },
        },
        {
          name: 'describe_table',
          description: 'Get table structure',
          inputSchema: {
            type: 'object',
            properties: {
              table: {
                type: 'string',
                description: 'Table name',
              },
              schema: {
                type: 'string',
                description: 'Schema name (default: public)',
              },
            },
            required: ['table'],
          },
        },
      ],
    }));
  
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'connect_db':
          return await this.handleConnectDb(request.params.arguments);
        case 'query':
          return await this.handleQuery(request.params.arguments);
        case 'execute':
          return await this.handleExecute(request.params.arguments);
        case 'list_schemas':
          return await this.handleListSchemas();
        case 'list_tables':
          return await this.handleListTables(request.params.arguments);
        case 'describe_table':
          return await this.handleDescribeTable(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async handleConnectDb(args: any) {
    // Close existing connection if any
    if (this.client) {
      await this.client.end();
      this.client = null;
    }

    // If no arguments provided, try to use environment variables
    if (!args.host || !args.user || !args.password || !args.database) {
      console.log('[MCP] No connection arguments provided, trying environment variables...');
      const envConfig = this.getEnvConfig();
      if (envConfig) {
        this.config = envConfig;
        console.log('[MCP] Using environment variables for database connection');
      } else {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Missing required database configuration parameters. Provide connection details or set environment variables (PG_HOST, PG_USER, PG_PASSWORD, PG_DATABASE).'
        );
      }
    } else {
      // Use provided arguments
      this.config = {
        host: args.host,
        port: args.port || 5432,
        user: args.user,
        password: args.password,
        database: args.database,
        // Add SSL configuration - default to rejectUnauthorized: false for common SSL issues
        ssl: args.ssl !== undefined ? args.ssl : { rejectUnauthorized: false }
      };
    }

    try {
      await this.ensureConnection();
      return {
        content: [
          {
            type: 'text',
            text: 'Successfully connected to PostgreSQL database',
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to connect to database: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleQuery(args: any) {
    await this.ensureConnection();

    if (!args.sql) {
      throw new McpError(ErrorCode.InvalidParams, 'SQL query is required');
    }

    if (!args.sql.trim().toUpperCase().startsWith('SELECT')) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Only SELECT queries are allowed with query tool'
      );
    }

    try {
      // Convert ? parameters to $1, $2, etc. if needed
      const sql = args.sql.includes('?') ? convertToNamedParams(args.sql) : args.sql;
      const result = await this.client!.query(sql, args.params || []);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Query execution failed: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleExecute(args: any) {
    await this.ensureConnection();

    if (!args.sql) {
      throw new McpError(ErrorCode.InvalidParams, 'SQL query is required');
    }

    const sql = args.sql.trim().toUpperCase();
    if (sql.startsWith('SELECT')) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Use query tool for SELECT statements'
      );
    }

    try {
      // Convert ? parameters to $1, $2, etc. if needed
      const preparedSql = args.sql.includes('?') ? convertToNamedParams(args.sql) : args.sql;
      const result = await this.client!.query(preparedSql, args.params || []);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              rowCount: result.rowCount,
              command: result.command,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Query execution failed: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleListSchemas() {
    await this.ensureConnection();
  
    try {
      const result = await this.client!.query(`
        SELECT schema_name
        FROM information_schema.schemata
        ORDER BY schema_name
      `);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list schemas: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleListTables(args: any = {}) {
    await this.ensureConnection();
  
    const schema = args.schema || 'public';
  
    try {
      const result = await this.client!.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
        ORDER BY table_name
      `, [schema]);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list tables: ${getErrorMessage(error)}`
      );
    }
  }

  private async handleDescribeTable(args: any) {
    await this.ensureConnection();
  
    if (!args.table) {
      throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
    }
  
    const schema = args.schema || 'public';
  
    try {
      const result = await this.client!.query(`
        SELECT 
          c.column_name, 
          c.data_type, 
          c.is_nullable, 
          c.column_default,
          CASE 
            WHEN pk.constraint_type = 'PRIMARY KEY' THEN true 
            ELSE false 
          END AS is_primary_key,
          c.character_maximum_length
        FROM 
          information_schema.columns c
        LEFT JOIN (
          SELECT 
            tc.constraint_type, 
            kcu.column_name, 
            kcu.table_name,
            kcu.table_schema
          FROM 
            information_schema.table_constraints tc
          JOIN 
            information_schema.key_column_usage kcu
          ON 
            tc.constraint_name = kcu.constraint_name
          WHERE 
            tc.constraint_type = 'PRIMARY KEY'
        ) pk
        ON 
          c.column_name = pk.column_name
          AND c.table_name = pk.table_name
          AND c.table_schema = pk.table_schema
        WHERE 
          c.table_schema = $1 
          AND c.table_name = $2
        ORDER BY 
          c.ordinal_position
      `, [schema, args.table]);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to describe table: ${getErrorMessage(error)}`
      );
    }
  }

  async run() {
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
  
    const port = parseInt(process.env.PORT || '3000', 10);
    
    // Add request logging middleware
    app.use((req, res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${req.ip}`);
      next();
    });
  
    // Health check endpoint
    app.get('/', (_: unknown, res: any) => {
      res.json({
        name: 'postgres-server',
        version: '1.0.0',
        status: 'running',
        capabilities: { tools: {} }
      });
    });

    // MCP SSE endpoint for Agent Builder integration
    app.get('/sse', async (req: any, res: any) => {
      console.log('[MCP] SSE connection established');
      
      // Set SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });

      // Create SSE transport
      const transport = new SSEServerTransport('/sse', res);
      
      // Connect the MCP server to the transport
      await this.server.connect(transport);
      
      // Handle connection cleanup
      req.on('close', () => {
        console.log('[MCP] SSE connection closed');
        transport.close();
      });
    });

    // Handle MCP requests at root path (for Agent Builder)
    app.post('/', async (req: any, res: any) => {
      console.log(`[MCP] Received root POST request:`, req.body);
      try {
        const { jsonrpc, method, id, params } = req.body;
        
        // Handle MCP protocol methods
        if (method === 'initialize') {
          console.log(`[MCP] Initialize request from client:`, params.clientInfo);
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {
                tools: {}
              },
              serverInfo: {
                name: 'postgres-server',
                version: '1.0.0'
              }
            }
          });
        } else if (method === 'notifications/initialized') {
          console.log(`[MCP] Client initialized notification received`);
          return res.json({
            jsonrpc: '2.0',
            id: null // notifications don't have IDs
          });
        } else if (method === 'tools/list') {
          console.log(`[MCP] Tools list request`);
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: 'connect_db',
                  description: 'Connect to PostgreSQL database',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      host: { type: 'string', description: 'Database host' },
                      port: { type: 'number', description: 'Database port (default: 5432)' },
                      user: { type: 'string', description: 'Database user' },
                      password: { type: 'string', description: 'Database password' },
                      database: { type: 'string', description: 'Database name' },
                      ssl: { 
                        type: ['boolean', 'object'], 
                        description: 'SSL configuration. Use false to disable SSL, true to enable with default settings, or { rejectUnauthorized: false } to disable certificate verification (recommended for cloud databases)' 
                      }
                    },
                    required: ['host', 'user', 'password', 'database']
                  }
                },
                {
                  name: 'query',
                  description: 'Execute a SELECT query',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      sql: { 
                        type: 'string', 
                        description: 'SQL SELECT query (use $1, $2, etc. for parameters)' 
                      },
                      params: { 
                        type: 'array',
                        items: {
                          type: ['string', 'number', 'boolean', 'null']
                        },
                        description: 'Query parameters (optional)' 
                      }
                    },
                    required: ['sql']
                  }
                },
                {
                  name: 'execute',
                  description: 'Execute an INSERT, UPDATE, or DELETE query',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      sql: { 
                        type: 'string', 
                        description: 'SQL query (INSERT, UPDATE, DELETE) (use $1, $2, etc. for parameters)' 
                      },
                      params: { 
                        type: 'array',
                        items: {
                          type: ['string', 'number', 'boolean', 'null']
                        },
                        description: 'Query parameters (optional)' 
                      }
                    },
                    required: ['sql']
                  }
                },
                {
                  name: 'list_schemas',
                  description: 'List all schemas in the database',
                  inputSchema: { type: 'object', properties: {}, required: [] }
                },
                {
                  name: 'list_tables',
                  description: 'List tables in the database',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      schema: { type: 'string', description: 'Schema name (default: public)' }
                    },
                    required: []
                  }
                },
                {
                  name: 'describe_table',
                  description: 'Get table structure',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      table: { type: 'string', description: 'Table name' },
                      schema: { type: 'string', description: 'Schema name (default: public)' }
                    },
                    required: ['table']
                  }
                }
              ]
            }
          });
        } else if (method === 'tools/call') {
          const { name, arguments: args } = params;
          console.log(`[MCP] Tool call: ${name}`);
          
          let result;
          switch (name) {
            case 'connect_db':
              result = await this.handleConnectDb(args);
              break;
            case 'list_tables':
              result = await this.handleListTables(args);
              break;
            case 'list_schemas':
              result = await this.handleListSchemas();
              break;
            case 'describe_table':
              result = await this.handleDescribeTable(args);
              break;
            case 'query':
              result = await this.handleQuery(args);
              break;
            case 'execute':
              result = await this.handleExecute(args);
              break;
            default:
              return res.json({
                jsonrpc: '2.0',
                id,
                error: {
                  code: -32601,
                  message: `Unknown tool: ${name}`
                }
              });
          }
          
          return res.json({
            jsonrpc: '2.0',
            id,
            result
          });
        } else {
          return res.json({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Unknown method: ${method}`
            }
          });
        }
      } catch (err: unknown) {
        console.error(`[MCP] Error handling root POST:`, err);
        const errorMessage = isErrorWithMessage(err) ? err.message : 'Unknown error';
        return res.json({
          jsonrpc: '2.0',
          id: req.body.id,
          error: {
            code: -32603,
            message: errorMessage
          }
        });
      }
    });
  
    // Optional health check
    app.get('/health', (_: unknown, res: any) => res.json({ status: 'ok' }));
  
    // MCP endpoints (legacy support)
    app.post('/:tool', async (req: any, res: any) => {
      const toolName = req.params.tool;
      console.log(`[MCP] Received request for tool: ${toolName}`);
      try {
        switch (toolName) {
          case 'connect_db':
            return res.json(await this.handleConnectDb(req.body));
          case 'list_tables':
            return res.json(await this.handleListTables(req.body));
          case 'list_schemas':
            return res.json(await this.handleListSchemas());
          case 'describe_table':
            return res.json(await this.handleDescribeTable(req.body));
          case 'query':
            return res.json(await this.handleQuery(req.body));
          case 'execute':
            return res.json(await this.handleExecute(req.body));
          default:
            console.log(`[MCP] Unknown tool requested: ${toolName}`);
            return res.status(404).json({ error: `Unknown endpoint: ${toolName}` });
        }
      } catch (err: unknown) {
        console.error(`[MCP] Error handling ${toolName}:`, err);
        const errorMessage = isErrorWithMessage(err) ? err.message : 'Unknown error';
        res.status(500).json({ error: errorMessage });
      }
    });
  
    // Add catch-all route for debugging
    app.use((req, res) => {
      console.log(`[DEBUG] Unhandled ${req.method} request to ${req.path}`);
      res.status(404).json({ 
        error: `Route not found: ${req.method} ${req.path}`,
        availableRoutes: ['GET /', 'GET /health', 'GET /sse', 'POST /', 'POST /:tool']
      });
    });

    app.listen(port, '0.0.0.0', () => {
      console.log(`🚀 MCP Postgres server listening on port ${port}`);
      console.log(`[MCP] Server bound to 0.0.0.0:${port}`);
      console.log(`[MCP] Environment: NODE_ENV=${process.env.NODE_ENV}`);
      console.log(`[MCP] Available routes:`);
      console.log(`[MCP]   GET  / (server info)`);
      console.log(`[MCP]   GET  /health (health check)`);
      console.log(`[MCP]   GET  /sse (MCP SSE endpoint for Agent Builder)`);
      console.log(`[MCP]   POST / (MCP protocol endpoint)`);
      console.log(`[MCP]   POST /:tool (legacy tool endpoints)`);
    });
  }
  
}

const server = new PostgresServer();
server.run().catch(console.error);

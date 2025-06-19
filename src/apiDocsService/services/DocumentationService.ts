import { logger } from '../../services/LoggerService.js';
import { API_CATEGORIES, type ApiCategory } from '../config.js';
import allEndpoints from '../endpoints/index.js';

export interface EndpointDefinition {
  method: string;
  path: string;
  description: string;
  category: ApiCategory;
  requiresAuth?: boolean;
  requiresAdmin?: boolean;
  parameters?: {
    path?: Record<string, string>;
    query?: Record<string, string>;
    body?: Record<string, string>;
    headers?: Record<string, string>;
  };
  responses?: Record<string, string>;
  examples?: {
    request?: any;
    response?: any;
  };
}

export interface CategoryDefinition {
  name: string;
  description: string;
  color: string;
  endpoints: EndpointDefinition[];
}

class DocumentationService {
  private static instance: DocumentationService;
  private endpoints: Map<string, EndpointDefinition> = new Map();
  private categories: Map<ApiCategory, CategoryDefinition> = new Map();

  private constructor() {
    this.initializeCategories();
    this.loadEndpointsFromFiles();
  }

  public static getInstance(): DocumentationService {
    if (!DocumentationService.instance) {
      DocumentationService.instance = new DocumentationService();
    }
    return DocumentationService.instance;
  }

  private initializeCategories(): void {
    Object.entries(API_CATEGORIES).forEach(([key, config]) => {
      this.categories.set(key as ApiCategory, {
        ...config,
        endpoints: []
      });
    });
  }

  private loadEndpointsFromFiles(): void {
    // Load all endpoints from the endpoint files
    allEndpoints.forEach(endpoint => {
      this.addEndpoint(endpoint);
    });
    
    logger.info(`Loaded ${allEndpoints.length} endpoints from endpoint files`);
  }

  public addEndpoint(endpoint: EndpointDefinition): void {
    const key = `${endpoint.method}:${endpoint.path}`;
    this.endpoints.set(key, endpoint);
    
    const category = this.categories.get(endpoint.category);
    if (category) {
      category.endpoints.push(endpoint);
    }
    
    logger.debug(`Added endpoint: ${key}`);
  }

  public getEndpoint(method: string, path: string): EndpointDefinition | undefined {
    const key = `${method}:${path}`;
    return this.endpoints.get(key);
  }

  public getAllEndpoints(): EndpointDefinition[] {
    return Array.from(this.endpoints.values());
  }

  public getEndpointsByCategory(category: ApiCategory): EndpointDefinition[] {
    const categoryData = this.categories.get(category);
    return categoryData ? categoryData.endpoints : [];
  }

  public getCategories(): Map<ApiCategory, CategoryDefinition> {
    return this.categories;
  }

  public getCategory(category: ApiCategory): CategoryDefinition | undefined {
    return this.categories.get(category);
  }

  public searchEndpoints(query: string): EndpointDefinition[] {
    const searchTerm = query.toLowerCase();
    return Array.from(this.endpoints.values()).filter(endpoint => 
      endpoint.path.toLowerCase().includes(searchTerm) ||
      endpoint.description.toLowerCase().includes(searchTerm) ||
      endpoint.method.toLowerCase().includes(searchTerm)
    );
  }

  public updateEndpoint(method: string, path: string, updates: Partial<EndpointDefinition>): boolean {
    const key = `${method}:${path}`;
    const existing = this.endpoints.get(key);
    
    if (!existing) {
      return false;
    }

    const updated = { ...existing, ...updates };
    this.endpoints.set(key, updated);
    
    // Update in category as well
    const category = this.categories.get(existing.category);
    if (category) {
      const index = category.endpoints.findIndex(ep => 
        ep.method === method && ep.path === path
      );
      if (index !== -1) {
        category.endpoints[index] = updated;
      }
    }
    
    logger.debug(`Updated endpoint: ${key}`);
    return true;
  }

  public removeEndpoint(method: string, path: string): boolean {
    const key = `${method}:${path}`;
    const endpoint = this.endpoints.get(key);
    
    if (!endpoint) {
      return false;
    }

    this.endpoints.delete(key);
    
    // Remove from category as well
    const category = this.categories.get(endpoint.category);
    if (category) {
      category.endpoints = category.endpoints.filter(ep => 
        !(ep.method === method && ep.path === path)
      );
    }
    
    logger.debug(`Removed endpoint: ${key}`);
    return true;
  }

  public exportOpenAPISpec(): any {
    const paths: Record<string, any> = {};
    
    this.endpoints.forEach(endpoint => {
      if (!paths[endpoint.path]) {
        paths[endpoint.path] = {};
      }
      
      paths[endpoint.path][endpoint.method.toLowerCase()] = {
        summary: endpoint.description,
        description: endpoint.description,
        tags: [endpoint.category],
        security: endpoint.requiresAuth ? [{ bearerAuth: [] }] : [],
        parameters: this.buildOpenAPIParameters(endpoint),
        requestBody: this.buildOpenAPIRequestBody(endpoint),
        responses: this.buildOpenAPIResponses(endpoint)
      };
    });

    return {
      openapi: '3.0.0',
      info: {
        title: 'TUF API',
        version: '2.0.0',
        description: 'The Universal Forums API Documentation'
      },
      servers: [
        {
          url: 'http://localhost:3000',
          description: 'Development server'
        }
      ],
      security: [
        {
          bearerAuth: []
        }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          }
        }
      },
      paths
    };
  }

  private buildOpenAPIParameters(endpoint: EndpointDefinition): any[] {
    const parameters: any[] = [];
    
    // Path parameters
    if (endpoint.parameters?.path) {
      Object.entries(endpoint.parameters.path).forEach(([name, description]) => {
        parameters.push({
          name,
          in: 'path',
          required: true,
          description,
          schema: { type: 'string' }
        });
      });
    }
    
    // Query parameters
    if (endpoint.parameters?.query) {
      Object.entries(endpoint.parameters.query).forEach(([name, description]) => {
        parameters.push({
          name,
          in: 'query',
          required: false,
          description,
          schema: { type: 'string' }
        });
      });
    }
    
    // Header parameters
    if (endpoint.parameters?.headers) {
      Object.entries(endpoint.parameters.headers).forEach(([name, description]) => {
        parameters.push({
          name,
          in: 'header',
          required: description.includes('(required)'),
          description: description.replace(/\(required\)|\(optional\)/g, '').trim(),
          schema: { type: 'string' }
        });
      });
    }
    
    return parameters;
  }

  private buildOpenAPIRequestBody(endpoint: EndpointDefinition): any {
    if (!endpoint.parameters?.body) {
      return undefined;
    }

    const properties: Record<string, any> = {};
    const required: string[] = [];
    
    Object.entries(endpoint.parameters.body).forEach(([name, description]) => {
      const isRequired = description.includes('(required)');
      if (isRequired) {
        required.push(name);
      }
      
      properties[name] = {
        type: 'string',
        description: description.replace(/\(required\)|\(optional\)/g, '').trim()
      };
    });

    return {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties,
            required
          }
        }
      }
    };
  }

  private buildOpenAPIResponses(endpoint: EndpointDefinition): Record<string, any> {
    const responses: Record<string, any> = {};
    
    if (endpoint.responses) {
      Object.entries(endpoint.responses).forEach(([code, description]) => {
        responses[code] = {
          description,
          content: {
            'application/json': {
              schema: {
                type: 'object'
              }
            }
          }
        };
      });
    }
    
    return responses;
  }
}

export default DocumentationService; 
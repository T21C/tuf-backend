import express, { Request, Response } from 'express';
import { logger } from '../../services/LoggerService.js';
import DocumentationService from '../services/DocumentationService.js';

const router = express.Router();

// Get API endpoints metadata
router.get('/endpoints', (req: Request, res: Response) => {
  try {
    const docService = DocumentationService.getInstance();
    const categories = docService.getCategories();
    
    const endpoints: Record<string, any> = {};
    
    categories.forEach((category, key) => {
      endpoints[key.toLowerCase()] = {
        name: category.name,
        description: category.description,
        color: category.color,
        endpoints: category.endpoints.map(endpoint => ({
          method: endpoint.method,
          path: endpoint.path,
          description: endpoint.description,
          category: endpoint.category,
          requiresAuth: endpoint.requiresAuth || false,
          requiresAdmin: endpoint.requiresAdmin || false,
          parameters: endpoint.parameters || {},
          responses: endpoint.responses || {},
          examples: endpoint.examples || {}
        }))
      };
    });
    
    res.json(endpoints);
  } catch (error) {
    logger.error('Error fetching endpoints:', error);
    res.status(500).json({ error: 'Failed to fetch endpoints' });
  }
});

// Get endpoint details
router.get('/endpoints/:category/:method/:path(*)', (req: Request, res: Response) => {
  try {
    const { category, method, path } = req.params;
    const docService = DocumentationService.getInstance();
    
    const endpoint = docService.getEndpoint(method.toUpperCase(), `/${path}`);
    
    if (!endpoint) {
      return res.status(404).json({ error: 'Endpoint not found' });
    }
    
    res.json(endpoint);
  } catch (error) {
    logger.error('Error fetching endpoint details:', error);
    res.status(500).json({ error: 'Failed to fetch endpoint details' });
  }
  return;
});

// Search endpoints
router.get('/search', (req: Request, res: Response) => {
  try {
    const { q } = req.query;
    
    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    const docService = DocumentationService.getInstance();
    const results = docService.searchEndpoints(q);
    
    res.json({
      query: q,
      results: results.map(endpoint => ({
        method: endpoint.method,
        path: endpoint.path,
        description: endpoint.description,
        category: endpoint.category,
        requiresAuth: endpoint.requiresAuth || false,
        requiresAdmin: endpoint.requiresAdmin || false
      }))
    });
  } catch (error) {
    logger.error('Error searching endpoints:', error);
    res.status(500).json({ error: 'Failed to search endpoints' });
  }
return;
});

// Get categories
router.get('/categories', (req: Request, res: Response) => {
  try {
    const docService = DocumentationService.getInstance();
    const categories = docService.getCategories();
    
    const categoriesList = Array.from(categories.entries()).map(([key, category]) => ({
      key,
      name: category.name,
      description: category.description,
      color: category.color,
      endpointCount: category.endpoints.length,
      authRequiredCount: category.endpoints.filter(ep => ep.requiresAuth).length,
      adminOnlyCount: category.endpoints.filter(ep => ep.requiresAdmin).length
    }));
    
    res.json(categoriesList);
  } catch (error) {
    logger.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Get API statistics
router.get('/stats', (req: Request, res: Response) => {
  try {
    const docService = DocumentationService.getInstance();
    const categories = docService.getCategories();
    const allEndpoints = docService.getAllEndpoints();
    
    const stats = {
      totalEndpoints: allEndpoints.length,
      totalCategories: categories.size,
      authRequiredEndpoints: allEndpoints.filter(ep => ep.requiresAuth).length,
      adminOnlyEndpoints: allEndpoints.filter(ep => ep.requiresAdmin).length,
      publicEndpoints: allEndpoints.filter(ep => !ep.requiresAuth && !ep.requiresAdmin).length,
      methods: {
        GET: allEndpoints.filter(ep => ep.method === 'GET').length,
        POST: allEndpoints.filter(ep => ep.method === 'POST').length,
        PUT: allEndpoints.filter(ep => ep.method === 'PUT').length,
        DELETE: allEndpoints.filter(ep => ep.method === 'DELETE').length,
        PATCH: allEndpoints.filter(ep => ep.method === 'PATCH').length,
        HEAD: allEndpoints.filter(ep => ep.method === 'HEAD').length
      },
      categories: Array.from(categories.entries()).map(([key, category]) => ({
        name: category.name,
        endpointCount: category.endpoints.length,
        authRequiredCount: category.endpoints.filter(ep => ep.requiresAuth).length,
        adminOnlyCount: category.endpoints.filter(ep => ep.requiresAdmin).length
      }))
    };
    
    res.json(stats);
  } catch (error) {
    logger.error('Error fetching API stats:', error);
    res.status(500).json({ error: 'Failed to fetch API stats' });
  }
});

// Health check endpoint
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'api-docs',
    timestamp: new Date().toISOString()
  });
});

export default router; 
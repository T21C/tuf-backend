import express, { Request, Response } from 'express';
import { API_DOCS_CONFIG, API_CATEGORIES } from '../config.js';
import { logger } from '../../services/LoggerService.js';
import DocumentationService from '../services/DocumentationService.js';

const router = express.Router();

// Serve the main documentation page
router.get('/', (req: Request, res: Response) => {
  const docService = DocumentationService.getInstance();
  const categories = docService.getCategories();
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${API_DOCS_CONFIG.title}</title>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
          background: #0f0f23;
          color: #ffffff;
          line-height: 1.6;
        }
        
        .container {
          max-width: 1400px;
          margin: 0 auto;
          padding: 20px;
        }
        
        .header {
          text-align: center;
          margin-bottom: 40px;
          padding: 40px 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 12px;
        }
        
        .header h1 {
          font-size: 2.5rem;
          font-weight: 700;
          margin-bottom: 10px;
          background: linear-gradient(45deg, #fff, #f0f0f0);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        
        .header p {
          font-size: 1.1rem;
          opacity: 0.9;
          max-width: 600px;
          margin: 0 auto;
        }
        
        .version-badge {
          display: inline-block;
          background: rgba(255, 255, 255, 0.2);
          padding: 4px 12px;
          border-radius: 20px;
          font-size: 0.9rem;
          margin-top: 10px;
        }
        
        .stats-bar {
          display: flex;
          justify-content: space-around;
          background: #1a1a2e;
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 30px;
          border: 1px solid #2a2a3e;
        }
        
        .stat-item {
          text-align: center;
        }
        
        .stat-number {
          font-size: 2rem;
          font-weight: 700;
          color: #667eea;
          display: block;
        }
        
        .stat-label {
          font-size: 0.9rem;
          color: #a0a0a0;
          margin-top: 4px;
        }
        
        .search-section {
          margin-bottom: 30px;
        }
        
        .search-box {
          width: 100%;
          padding: 16px 20px;
          background: #1a1a2e;
          border: 2px solid #2a2a3e;
          border-radius: 12px;
          color: #ffffff;
          font-size: 1rem;
          transition: border-color 0.3s ease;
        }
        
        .search-box:focus {
          outline: none;
          border-color: #667eea;
        }
        
        .search-box::placeholder {
          color: #666;
        }
        
        .filter-controls {
          display: flex;
          gap: 15px;
          margin-top: 15px;
          flex-wrap: wrap;
        }
        
        .filter-select {
          padding: 8px 12px;
          background: #1a1a2e;
          border: 1px solid #2a2a3e;
          border-radius: 6px;
          color: #ffffff;
          font-size: 0.9rem;
        }
        
        .filter-select:focus {
          outline: none;
          border-color: #667eea;
        }
        
        .categories {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
          gap: 20px;
          margin-bottom: 40px;
        }
        
        .category-card {
          background: #1a1a2e;
          border-radius: 12px;
          padding: 24px;
          border: 1px solid #2a2a3e;
          transition: all 0.3s ease;
          cursor: pointer;
          position: relative;
        }
        
        .category-card:hover {
          transform: translateY(-2px);
          border-color: #667eea;
          box-shadow: 0 8px 25px rgba(102, 126, 234, 0.15);
        }
        
        .category-card.active {
          border-color: #667eea;
          background: #1a1a2e;
          box-shadow: 0 8px 25px rgba(102, 126, 234, 0.15);
        }
        
        .category-header {
          display: flex;
          align-items: center;
          margin-bottom: 12px;
        }
        
        .category-icon {
          width: 40px;
          height: 40px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-right: 12px;
          font-size: 1.2rem;
          font-weight: 600;
        }
        
        .category-title {
          font-size: 1.3rem;
          font-weight: 600;
          color: #ffffff;
        }
        
        .category-description {
          color: #a0a0a0;
          font-size: 0.95rem;
          line-height: 1.5;
        }
        
        .endpoint-count {
          margin-top: 12px;
          font-size: 0.85rem;
          color: #667eea;
          font-weight: 500;
        }
        
        .endpoints-section {
          background: #1a1a2e;
          border-radius: 12px;
          padding: 24px;
          border: 1px solid #2a2a3e;
        }
        
        .section-title {
          font-size: 1.5rem;
          font-weight: 600;
          margin-bottom: 20px;
          color: #ffffff;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        
        .section-controls {
          display: flex;
          gap: 10px;
          align-items: center;
        }
        
        .toggle-all-btn {
          padding: 6px 12px;
          background: #667eea;
          border: none;
          border-radius: 6px;
          color: white;
          font-size: 0.85rem;
          cursor: pointer;
          transition: background 0.3s ease;
        }
        
        .toggle-all-btn:hover {
          background: #5a67d8;
        }
        
        .endpoint-list {
          display: none;
        }
        
        .endpoint-list.active {
          display: block;
        }
        
        .endpoint-item {
          background: #0f0f23;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 16px;
          border: 1px solid #2a2a3e;
          transition: all 0.3s ease;
        }
        
        .endpoint-item:hover {
          border-color: #667eea;
          background: #1a1a2e;
        }
        
        .endpoint-header {
          display: flex;
          align-items: center;
          margin-bottom: 12px;
          cursor: pointer;
        }
        
        .method-badge {
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 0.85rem;
          font-weight: 600;
          margin-right: 15px;
          min-width: 70px;
          text-align: center;
        }
        
        .method-get { background: #10b981; color: white; }
        .method-post { background: #3b82f6; color: white; }
        .method-put { background: #f59e0b; color: white; }
        .method-delete { background: #ef4444; color: white; }
        .method-patch { background: #8b5cf6; color: white; }
        .method-head { background: #6b7280; color: white; }
        
        .endpoint-path {
          font-family: 'Monaco', 'Menlo', monospace;
          font-size: 1rem;
          color: #ffffff;
          font-weight: 500;
          flex: 1;
        }
        
        .endpoint-description {
          color: #a0a0a0;
          font-size: 0.95rem;
          margin-left: 85px;
          margin-bottom: 12px;
        }
        
        .auth-badge {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 0.75rem;
          font-weight: 500;
          margin-left: 10px;
        }
        
        .auth-required { background: #dc2626; color: white; }
        .auth-admin { background: #7c3aed; color: white; }
        .auth-none { background: #059669; color: white; }
        
        .endpoint-details {
          margin-top: 16px;
          margin-left: 85px;
          display: none;
          background: #0f0f23;
          border-radius: 8px;
          padding: 16px;
          border: 1px solid #2a2a3e;
        }
        
        .detail-section {
          margin-bottom: 20px;
        }
        
        .detail-section:last-child {
          margin-bottom: 0;
        }
        
        .detail-title {
          font-size: 1rem;
          font-weight: 600;
          color: #667eea;
          margin-bottom: 12px;
          display: flex;
          align-items: center;
        }
        
        .detail-title::before {
          content: '';
          width: 4px;
          height: 16px;
          background: #667eea;
          margin-right: 8px;
          border-radius: 2px;
        }
        
        .parameter-list {
          background: #1a1a2e;
          border-radius: 6px;
          padding: 12px;
          font-family: 'Monaco', 'Menlo', monospace;
          font-size: 0.85rem;
          color: #e0e0e0;
        }
        
        .parameter-item {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 8px 0;
          border-bottom: 1px solid #2a2a3e;
        }
        
        .parameter-item:last-child {
          border-bottom: none;
        }
        
        .parameter-name {
          font-weight: 600;
          color: #667eea;
          min-width: 120px;
        }
        
        .parameter-type {
          color: #f59e0b;
          font-size: 0.8rem;
          margin-left: 8px;
        }
        
        .parameter-description {
          flex: 1;
          margin-left: 16px;
        }
        
        .response-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 0;
          border-bottom: 1px solid #2a2a3e;
        }
        
        .response-item:last-child {
          border-bottom: none;
        }
        
        .response-code {
          font-weight: 600;
          min-width: 60px;
        }
        
        .response-200 { color: #10b981; }
        .response-201 { color: #10b981; }
        .response-400 { color: #f59e0b; }
        .response-401 { color: #ef4444; }
        .response-403 { color: #ef4444; }
        .response-404 { color: #ef4444; }
        .response-500 { color: #ef4444; }
        
        .response-description {
          flex: 1;
          margin-left: 16px;
        }
        
        .expand-icon {
          margin-left: 10px;
          transition: transform 0.3s ease;
          font-size: 1.2rem;
        }
        
        .expand-icon.expanded {
          transform: rotate(180deg);
        }
        
        .no-results {
          text-align: center;
          padding: 40px;
          color: #666;
          font-style: italic;
        }
        
        .footer {
          text-align: center;
          margin-top: 60px;
          padding: 40px 0;
          border-top: 1px solid #2a2a3e;
          color: #666;
        }
        
        .footer a {
          color: #667eea;
          text-decoration: none;
        }
        
        .footer a:hover {
          text-decoration: underline;
        }
        
        @media (max-width: 768px) {
          .container {
            padding: 15px;
          }
          
          .header h1 {
            font-size: 2rem;
          }
          
          .categories {
            grid-template-columns: 1fr;
          }
          
          .stats-bar {
            flex-direction: column;
            gap: 15px;
          }
          
          .filter-controls {
            flex-direction: column;
          }
          
          .endpoint-header {
            flex-direction: column;
            align-items: flex-start;
            gap: 8px;
          }
          
          .endpoint-description {
            margin-left: 0;
          }
          
          .endpoint-details {
            margin-left: 0;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${API_DOCS_CONFIG.title}</h1>
          <p>${API_DOCS_CONFIG.description}</p>
          <div class="version-badge">v${API_DOCS_CONFIG.version}</div>
        </div>
        
        <div class="stats-bar">
          <div class="stat-item">
            <span class="stat-number" id="totalEndpoints">-</span>
            <span class="stat-label">Total Endpoints</span>
          </div>
          <div class="stat-item">
            <span class="stat-number" id="totalCategories">-</span>
            <span class="stat-label">Categories</span>
          </div>
          <div class="stat-item">
            <span class="stat-number" id="protectedEndpoints">-</span>
            <span class="stat-label">Protected Endpoints</span>
          </div>
          <div class="stat-item">
            <span class="stat-number" id="adminEndpoints">-</span>
            <span class="stat-label">Admin Only</span>
          </div>
        </div>
        
        <div class="search-section">
          <input type="text" class="search-box" placeholder="Search endpoints by path, description, or method..." id="searchBox">
          <div class="filter-controls">
            <select class="filter-select" id="categoryFilter">
              <option value="">All Categories</option>
              ${Array.from(categories.entries()).map(([key, category]) => 
                `<option value="${key.toLowerCase()}">${category.name} (${category.endpoints.length})</option>`
              ).join('')}
            </select>
            <select class="filter-select" id="methodFilter">
              <option value="">All Methods</option>
              <option value="get">GET</option>
              <option value="post">POST</option>
              <option value="put">PUT</option>
              <option value="delete">DELETE</option>
              <option value="patch">PATCH</option>
              <option value="head">HEAD</option>
            </select>
            <select class="filter-select" id="authFilter">
              <option value="">All Auth Levels</option>
              <option value="none">No Auth Required</option>
              <option value="auth">Auth Required</option>
              <option value="admin">Admin Only</option>
            </select>
          </div>
        </div>
        
        <div class="categories" id="categories">
          ${Array.from(categories.entries()).map(([key, category]) => `
            <div class="category-card" data-category="${key.toLowerCase()}">
              <div class="category-header">
                <div class="category-icon" style="background: ${category.color}20; color: ${category.color}">
                  ${key.charAt(0)}
                </div>
                <div>
                  <div class="category-title">${category.name}</div>
                  <div class="category-description">${category.description}</div>
                </div>
              </div>
              <div class="endpoint-count" id="count-${key.toLowerCase()}">${category.endpoints.length} endpoint${category.endpoints.length !== 1 ? 's' : ''}</div>
            </div>
          `).join('')}
        </div>
        
        <div class="endpoints-section">
          <div class="section-title">
            API Endpoints
            <div class="section-controls">
              <button class="toggle-all-btn" id="toggleAllBtn">Expand All</button>
            </div>
          </div>
          <div id="endpointsList">
            <!-- Endpoints will be loaded here -->
          </div>
        </div>
      </div>
      
      <div class="footer">
        <p>© 2024 TUF Development Team. <a href="${API_DOCS_CONFIG.license.url}" target="_blank">${API_DOCS_CONFIG.license.name}</a></p>
        <p>Contact: <a href="mailto:${API_DOCS_CONFIG.contact.email}">${API_DOCS_CONFIG.contact.email}</a></p>
      </div>
      
      <script>
        // Global variables to store API data
        let apiStats = {};
        let endpointsData = {};
        
        // Fetch API statistics
        async function fetchApiStats() {
          try {
            const response = await fetch('${API_DOCS_CONFIG.baseUrl}/api/stats');
            const data = await response.json();
            return data;
          } catch (error) {
            console.error('Error fetching API stats:', error);
            return {};
          }
        }
        
        // Fetch endpoints data from the API
        async function fetchEndpoints() {
          try {
            const response = await fetch('${API_DOCS_CONFIG.baseUrl}/api/endpoints');
            const data = await response.json();
            return data;
          } catch (error) {
            console.error('Error fetching endpoints:', error);
            return {};
          }
        }
        
        // Update statistics display
        function updateStatsDisplay(stats) {
          document.getElementById('totalEndpoints').textContent = stats.totalEndpoints || '-';
          document.getElementById('totalCategories').textContent = stats.totalCategories || '-';
          document.getElementById('protectedEndpoints').textContent = stats.authRequiredEndpoints || '-';
          document.getElementById('adminEndpoints').textContent = stats.adminOnlyEndpoints || '-';
        }
        
        // Initialize the documentation
        async function initializeDocs() {
          // Fetch both stats and endpoints data
          const [stats, endpoints] = await Promise.all([
            fetchApiStats(),
            fetchEndpoints()
          ]);
          
          apiStats = stats;
          endpointsData = endpoints;
          
          // Update stats display
          updateStatsDisplay(stats);
          
          // Render endpoints
          renderEndpoints(endpoints);
          setupEventListeners();
        }
        
        // Render all endpoints
        function renderEndpoints(endpointsData) {
          const container = document.getElementById('endpointsList');
          let html = '';
          
          Object.entries(endpointsData).forEach(([category, categoryData]) => {
            html += \`<div class="endpoint-list" id="\${category}-endpoints">\`;
            categoryData.endpoints.forEach(endpoint => {
              html += createEndpointHTML(endpoint);
            });
            html += '</div>';
          });
          
          container.innerHTML = html;
        }
        
        // Create HTML for a single endpoint
        function createEndpointHTML(endpoint) {
          const parameters = endpoint.parameters || {};
          const responses = endpoint.responses || {};
          
          // Determine auth badge
          let authBadge = '';
          if (endpoint.requiresAdmin) {
            authBadge = '<span class="auth-badge auth-admin">Admin</span>';
          } else if (endpoint.requiresAuth) {
            authBadge = '<span class="auth-badge auth-required">Auth</span>';
          } else {
            authBadge = '<span class="auth-badge auth-none">Public</span>';
          }
          
          // Create parameters HTML
          let parametersHTML = '';
          if (Object.keys(parameters).length > 0) {
            parametersHTML = Object.entries(parameters).map(([type, params]) => {
              const paramList = Object.entries(params).map(([name, desc]) => 
                \`<div class="parameter-item">
                  <div>
                    <span class="parameter-name">\${name}</span>
                    <span class="parameter-type">\${type}</span>
                  </div>
                  <div class="parameter-description">\${desc}</div>
                </div>\`
              ).join('');
              return \`<div class="detail-section">
                <div class="detail-title">\${type.toUpperCase()} Parameters</div>
                <div class="parameter-list">\${paramList}</div>
              </div>\`;
            }).join('');
          }
          
          // Create responses HTML
          let responsesHTML = '';
          if (Object.keys(responses).length > 0) {
            const responseList = Object.entries(responses).map(([code, desc]) => 
              \`<div class="response-item">
                <span class="response-code response-\${code}">\${code}</span>
                <div class="response-description">\${desc}</div>
              </div>\`
            ).join('');
            responsesHTML = \`<div class="detail-section">
              <div class="detail-title">Responses</div>
              <div class="parameter-list">\${responseList}</div>
            </div>\`;
          }
          
          return \`
            <div class="endpoint-item" data-category="\${endpoint.category.toLowerCase()}" data-method="\${endpoint.method.toLowerCase()}" data-auth="\${endpoint.requiresAdmin ? 'admin' : endpoint.requiresAuth ? 'auth' : 'none'}">
              <div class="endpoint-header">
                <span class="method-badge method-\${endpoint.method.toLowerCase()}">\${endpoint.method}</span>
                <span class="endpoint-path">\${endpoint.path}</span>
                \${authBadge}
                <span class="expand-icon">▼</span>
              </div>
              <div class="endpoint-description">\${endpoint.description}</div>
              <div class="endpoint-details">
                \${parametersHTML}
                \${responsesHTML}
              </div>
            </div>
          \`;
        }
        
        // Setup event listeners
        function setupEventListeners() {
          // Category card clicks
          document.querySelectorAll('.category-card').forEach(card => {
            card.addEventListener('click', () => {
              const category = card.dataset.category;
              showCategory(category);
            });
          });
          
          // Search functionality
          document.getElementById('searchBox').addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase();
            filterEndpoints();
          });
          
          // Filter controls
          document.getElementById('categoryFilter').addEventListener('change', filterEndpoints);
          document.getElementById('methodFilter').addEventListener('change', filterEndpoints);
          document.getElementById('authFilter').addEventListener('change', filterEndpoints);
          
          // Endpoint item clicks
          document.addEventListener('click', (e) => {
            if (e.target.closest('.endpoint-header')) {
              const endpointItem = e.target.closest('.endpoint-item');
              const details = endpointItem.querySelector('.endpoint-details');
              const icon = endpointItem.querySelector('.expand-icon');
              
              details.style.display = details.style.display === 'block' ? 'none' : 'block';
              icon.classList.toggle('expanded');
            }
          });
          
          // Toggle all button
          document.getElementById('toggleAllBtn').addEventListener('click', () => {
            const details = document.querySelectorAll('.endpoint-details');
            const icons = document.querySelectorAll('.expand-icon');
            const isExpanded = details[0] && details[0].style.display === 'block';
            
            details.forEach(detail => {
              detail.style.display = isExpanded ? 'none' : 'block';
            });
            
            icons.forEach(icon => {
              icon.classList.toggle('expanded', !isExpanded);
            });
            
            document.getElementById('toggleAllBtn').textContent = isExpanded ? 'Expand All' : 'Collapse All';
          });
        }
        
        // Show specific category
        function showCategory(category) {
          // Hide all endpoint lists
          document.querySelectorAll('.endpoint-list').forEach(list => {
            list.classList.remove('active');
          });
          
          // Show selected category
          const selectedList = document.getElementById(\`\${category}-endpoints\`);
          if (selectedList) {
            selectedList.classList.add('active');
          }
          
          // Update active state
          document.querySelectorAll('.category-card').forEach(card => {
            card.classList.toggle('active', card.dataset.category === category);
          });
          
          // Update category filter
          document.getElementById('categoryFilter').value = category;
          filterEndpoints();
        }
        
        // Filter endpoints based on all criteria
        function filterEndpoints() {
          const searchTerm = document.getElementById('searchBox').value.toLowerCase();
          const categoryFilter = document.getElementById('categoryFilter').value;
          const methodFilter = document.getElementById('methodFilter').value;
          const authFilter = document.getElementById('authFilter').value;
          
          const endpointItems = document.querySelectorAll('.endpoint-item');
          let visibleCount = 0;
          
          endpointItems.forEach(item => {
            const path = item.querySelector('.endpoint-path').textContent.toLowerCase();
            const description = item.querySelector('.endpoint-description').textContent.toLowerCase();
            const method = item.querySelector('.method-badge').textContent.toLowerCase();
            const category = item.dataset.category;
            const auth = item.dataset.auth;
            
            const matchesSearch = path.includes(searchTerm) || 
                                 description.includes(searchTerm) || 
                                 method.includes(searchTerm);
            
            const matchesCategory = !categoryFilter || category === categoryFilter;
            const matchesMethod = !methodFilter || method === methodFilter;
            const matchesAuth = !authFilter || auth === authFilter;
            
            const matches = matchesSearch && matchesCategory && matchesMethod && matchesAuth;
            
            item.style.display = matches ? 'block' : 'none';
            if (matches) visibleCount++;
          });
          
          // Show/hide no results message
          const noResults = document.querySelector('.no-results');
          if (visibleCount === 0) {
            if (!noResults) {
              const container = document.getElementById('endpointsList');
              container.innerHTML = '<div class="no-results">No endpoints match your search criteria</div>';
            }
          } else if (noResults) {
            noResults.remove();
          }
        }
        
        // Initialize when DOM is loaded
        document.addEventListener('DOMContentLoaded', initializeDocs);
      </script>
    </body>
    </html>
  `);
});

// Serve API specification in JSON format
router.get('/spec', (req: Request, res: Response) => {
  try {
    const docService = DocumentationService.getInstance();
    const spec = docService.exportOpenAPISpec();
    res.json(spec);
  } catch (error) {
    logger.error('Error generating API spec:', error);
    res.status(500).json({ error: 'Failed to generate API specification' });
  }
});

export default router; 
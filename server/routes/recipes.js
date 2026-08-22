import { readJsonBody, sendJson } from './http.js';
import * as recipes from '../services/recipes.js';

export function recipesRoute() {
  return async (request, response, url) => {
    if (url.pathname === '/api/recipes' && request.method === 'GET') {
      sendJson(response, 200, { recipes: await recipes.listRecipes() });
      return true;
    }
    if (url.pathname === '/api/recipes' && request.method === 'POST') {
      sendJson(response, 201, { recipe: await recipes.createRecipe(await readJsonBody(request)) });
      return true;
    }
    if (url.pathname === '/api/recipes/import' && request.method === 'POST') {
      sendJson(response, 201, { recipe: await recipes.importRecipe(await readJsonBody(request)) });
      return true;
    }
    const match = url.pathname.match(/^\/api\/recipes\/([^/]+)$/u);
    if (!match) return false;
    const id = decodeURIComponent(match[1]);
    if (request.method === 'GET') {
      sendJson(response, 200, { recipe: await recipes.getRecipe(id) });
      return true;
    }
    if (request.method === 'PUT') {
      sendJson(response, 200, { recipe: await recipes.updateRecipe(id, await readJsonBody(request)) });
      return true;
    }
    if (request.method === 'DELETE') {
      sendJson(response, 200, await recipes.deleteRecipe(id));
      return true;
    }
    return false;
  };
}

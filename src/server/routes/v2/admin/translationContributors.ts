import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {
  parseContributorNameList,
  parseTranslationLanguageCode,
  replaceTranslationContributors,
  TranslationContributorInputError,
} from '@/server/services/translations/translationContributors.js';

const router = Router();

router.put(
  '/:lang',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminPutTranslationContributors',
    summary: 'Replace translation contributor names for a language',
    description:
      'Replaces the ordered contributor name list for a site language. Names are plain strings in display order.',
    tags: ['Admin', 'Utils'],
    security: ['bearerAuth'],
    params: {lang: {description: 'Site language code', schema: {type: 'string'}}},
    requestBody: {
      description: 'Ordered contributor names. Blank entries are dropped.',
      required: true,
    },
    responses: {
      200: {description: 'Updated name list'},
      400: {description: 'Invalid language or names'},
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const languageCode = parseTranslationLanguageCode(req.params.lang);
      const names = parseContributorNameList(req.body?.names);
      const saved = await replaceTranslationContributors(languageCode, names);
      return res.json({languageCode, names: saved});
    } catch (error) {
      if (error instanceof TranslationContributorInputError) {
        return res.status(error.status).json({error: error.message});
      }
      return respondMysqlClientError(res, error, 'Failed to save translation contributors', {
        logLabel: 'Save translation contributors failed:',
      });
    }
  },
);

export default router;

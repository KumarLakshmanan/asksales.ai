import type { Express, Request, RequestHandler, Response } from 'express';
import {
  createSavedSocialReport,
  deleteSavedSocialReport,
  exportSavedSocialReport,
  getSavedSocialReportExport,
  listSavedSocialReports,
  listSocialReportDeliveries,
  updateSavedSocialReport,
} from '../controllers/socialAnalyticsController.js';

type ReportHandler = (req: Request, res: Response) => Promise<unknown>;

// Express 4 does not forward a returned promise to the application's error
// middleware. Keep report failures inside that existing HTTP boundary.
const reportHandler = (handler: ReportHandler): RequestHandler => (req, res, next) => {
  void handler(req, res).catch(next);
};

export function registerSocialReportRoutes(
  app: Express,
  authenticate: RequestHandler,
  contentAccess: RequestHandler,
) {
  const base = '/api/social-analytics/reports';
  app.get(base, authenticate, contentAccess, reportHandler(listSavedSocialReports));
  app.post(base, authenticate, contentAccess, reportHandler(createSavedSocialReport));
  app.post(`${base}/:id/export`, authenticate, contentAccess, reportHandler(exportSavedSocialReport));
  app.get(`${base}/:id/deliveries`, authenticate, contentAccess, reportHandler(listSocialReportDeliveries));
  app.patch(`${base}/:id`, authenticate, contentAccess, reportHandler(updateSavedSocialReport));
  app.delete(`${base}/:id`, authenticate, contentAccess, reportHandler(deleteSavedSocialReport));
  app.get(`${base}/:id/exports/:exportId`, authenticate, contentAccess, reportHandler(getSavedSocialReportExport));
}

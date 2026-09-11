/**
 * 管理员接口。目前只有邀请码管理，但这是私人站点最需要的那个。
 */
import { Router } from 'express';
import { db, now, isFirstRun } from '../db.js';
import { requireAuth } from '../auth.js';
import { currentInvite, rotateInvite } from '../invite.js';
import { config } from '../config.js';
import { wrap, forbidden } from '../http.js';
import { freeDiskBytes } from '../util.js';
import { publicUser } from '../serialize.js';
import { onlineUserIds } from '../presence.js';

export const adminRouter = Router();

adminRouter.use(requireAuth);
adminRouter.use((req, _res, next) => {
  if (!req.user.is_admin) return next(forbidden('只有管理员能做这个操作'));
  next();
});

/** 站点概况：给管理员一个「这台服务器现在什么状态」的视图 */
adminRouter.get(
  '/overview',
  wrap(async (req, res) => {
    const counts = {
      users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      conversations: db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n,
      messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
      files: db.prepare('SELECT COUNT(*) AS n FROM files').get().n,
      storageBytes: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files').get().n,
      online: onlineUserIds().length,
    };
    const invite = currentInvite();
    res.json({
      counts,
      invite: { code: invite.code, source: invite.source },
      freeDiskBytes: await freeDiskBytes(config.uploadDir),
      members: db
        .prepare('SELECT * FROM users ORDER BY created_at')
        .all()
        .map((u) => ({ ...publicUser(u), createdAt: u.created_at })),
      limits: {
        maxFileBytes: config.maxFileBytes,
        dailyUploadQuota: config.dailyUploadQuota,
        minFreeDiskBytes: config.minFreeDiskBytes,
      },
      now: now(),
    });
  }),
);

/** 看当前邀请码 */
adminRouter.get('/invite', (req, res) => {
  const invite = currentInvite();
  res.json({
    code: invite.code,
    source: invite.source,
    // 用环境变量固定下来的码，在界面里不允许直接换，避免改了没生效造成困惑
    rotatable: invite.source !== 'env',
    registrationOpen: config.allowRegister && !isFirstRun(),
  });
});

/** 换一个新邀请码 */
adminRouter.post(
  '/invite/rotate',
  wrap(async (req, res) => {
    if (config.inviteCode) {
      return res.status(409).json({
        error: '邀请码被 INVITE_CODE 环境变量固定了，请在服务器上改配置再重启',
        code: 'invite_fixed',
      });
    }
    const invite = rotateInvite();
    res.json({ code: invite.code, source: invite.source, rotatable: true });
  }),
);

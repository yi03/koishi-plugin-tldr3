// --- START OF FILE index.ts ---

import { Context, Schema, Session, Time, Logger, h } from 'koishi'
import axios from 'axios'

export const name = 'tldr3'
export const description = '太长不看 - AI总结群聊消息 (交互式范围选择, 数据库存储, 支持机器人昵称占位符)'
// --- 更新 usage ---
export const usage = '使用 tldr3 命令启动消息总结流程，按照提示操作即可指定总结范围。\n使用 `tldr3 cancel` 命令可中途取消任务。\n消息记录会自动存储并在设定天数后清理。启用调试模式可在控制台查看详细请求信息。\n可在 System Prompt 中使用 {bot_name} 占位符代表机器人昵称。'

// --- 数据库模型定义 ---
declare module 'koishi' {
  interface Tables {
    tldr_messages: TldrMessage
  }
}

export interface TldrMessage {
  id: number
  messageId: string
  guildId: string
  userId: string
  username: string
  content: string
  timestamp: Date
}

// --- 插件配置 ---
export interface Config {
  openaiEndpoint: string
  openaiApiKey: string
  openaiModel: string
  openaiSystemPrompt: string // 可配置的 System Prompt
  commandTimeout: number
  Textlimit: number
  maxMessageAgeDays: number
  debugMode: boolean // 调试模式开关
}

export const Config: Schema<Config> = Schema.object({
  openaiEndpoint: Schema.string().description('OpenAI API 端点').default('https://api.openai.com/v1/chat/completions'),
  openaiApiKey: Schema.string().description('OpenAI API 密钥').required(),
  openaiModel: Schema.string().description('使用的 OpenAI 模型').default('gpt-3.5-turbo'),
  openaiSystemPrompt: Schema.string().role('textarea').description(
    '用于指导 AI 总结的系统提示词 (System Prompt)。\n你可以在提示词中使用 `{bot_name}` 占位符，它会在实际调用时被替换为当前机器人的昵称。'
  ).default(
    '你是一个群聊消息总结助手，你的名字是 {bot_name}。以下是来自一个群组的一段聊天记录，格式为 "用户名: 消息内容"。请你清晰、客观地总结这段对话的主要内容、讨论点或重要信息。请忽略无关紧要的闲聊、表情符号和格式标记 ([图片], [表情:xx] 等)，专注于核心信息。如果对话中有多方观点，请尽量分别概括。'
  ).experimental(),
  commandTimeout: Schema.number().description('命令交互超时时间（秒），0 表示永不超时').default(120),
  Textlimit: Schema.number().description('总结原文的最大字符数限制').default(60000),
  maxMessageAgeDays: Schema.number().description('消息在数据库中保留的最长天数，0 表示永久保留 (不推荐)').default(7),
  debugMode: Schema.boolean().description('启用调试模式，将本插件的日志级别设为 DEBUG，可在控制台打印发送给 OpenAI 的详细请求内容。').default(false),
})

// --- 插件实现 ---
export const using = ['database'] as const

export function apply(ctx: Context, config: Config) {
  // 在 apply 内部获取 logger 实例
  const logger = ctx.logger('tldr3');

  // --- 动态设置日志级别 ---
  if (config.debugMode) {
    // 强制将此 logger 实例的级别设为 DEBUG
    logger.level = Logger.DEBUG;
    logger.info('调试模式已启用，本插件将输出 DEBUG 级别日志。');
  } else {
    // 保持默认级别 (通常由 Koishi 全局配置决定，默认为 INFO)
    // logger.level = Logger.INFO; // 不需要显式设置回 INFO，保持默认即可
  }
  // --- 结束动态设置 ---

  logger.info('正在加载 tldr3 插件...');

  // 定义数据库表结构
  ctx.model.extend('tldr_messages', {
    id: 'unsigned', messageId: 'string', guildId: 'string', userId: 'string',
    username: 'string', content: 'text', timestamp: 'timestamp',
  }, { autoInc: true, indexes: [['guildId', 'timestamp'], ['guildId', 'messageId']] })

  // 会话状态存储 (内存)
  const sessionStore: Record<string, { userId: string; guildId: string; stage: 'start' | 'waitForSecond' | 'processing' | 'completed'; firstMessageId?: string; secondMessageId?: string; timer?: NodeJS.Timeout }> = {}

  // --- tldr 命令处理 ---
  ctx.command('tldr3', '启动交互式消息总结流程')
    .action(async ({ session }) => {
      if (!session) {
        return '发生内部错误：无法获取会话信息。';
      }
      if (!session.guildId || !session.userId) {
        return '该命令只能在群组中使用。';
      }

      const sessionId = `${session.guildId}-${session.userId}`;

      const existingSession = sessionStore[sessionId];
      // 检查是否正在进行中 (不是 completed 或 processing)
      if (existingSession && existingSession.stage !== 'completed' && existingSession.stage !== 'processing') {
        // --- 修改提示，加入 cancel 说明 ---
        return '您当前有一个总结任务正在进行中，请先完成或等待超时，或使用 `tldr3 cancel` 命令取消。'
      }

      // 清理旧会话和定时器（即使是 completed 的也清理掉以防万一）
      if (sessionStore[sessionId]?.timer) {
        clearTimeout(sessionStore[sessionId].timer);
      }
      if (sessionStore[sessionId]) {
        delete sessionStore[sessionId];
      }

      sessionStore[sessionId] = { userId: session.userId, guildId: session.guildId, stage: 'start' }

      if (config.commandTimeout > 0) {
        const timeoutSeconds = config.commandTimeout;
        const timerId = setTimeout(() => {
          const currentSession = sessionStore[sessionId];
          if (currentSession && currentSession.stage !== 'completed' && currentSession.stage !== 'processing') {
            logger.info(`[TLDR Timeout] 会话 ${sessionId} 因超时 (${timeoutSeconds}s) 已取消 (阶段: ${currentSession.stage})。`);
            delete sessionStore[sessionId];
            session.send('由于长时间未操作，tldr 总结任务已自动取消。').catch(err => logger.warn(`[TLDR Timeout] 发送取消消息失败 for ${sessionId}: ${err.message}`));
          }
        }, timeoutSeconds * 1000);
        sessionStore[sessionId].timer = timerId;
      }

      return 'tldr 总结任务已启动。\n请【回复】你想要作为【总结起点】的那条消息，并发送数字【1】。\n如需中途取消，请发送 `tldr3 cancel`。'
    })

  ctx.command('tldr3.cancel', '取消当前正在进行的 tldr 总结任务')
    .action(async ({ session }) => {
      if (!session) {
        return '发生内部错误：无法获取会话信息。';
      }
      if (!session.guildId || !session.userId) {
        return '该命令只能在群组中使用。';
      }

      const sessionId = `${session.guildId}-${session.userId}`;
      const currentSession = sessionStore[sessionId];

      if (!currentSession || currentSession.stage === 'completed') {
        return '您当前没有正在进行的 tldr 总结任务。';
      }

      if (currentSession.stage === 'processing') {
        return '任务已经开始处理，无法取消。请等待处理完成。';
      }

      // 清除定时器
      if (currentSession.timer) {
        clearTimeout(currentSession.timer);
      }

      // 删除会话状态
      const cancelledStage = currentSession.stage; // 记录被取消时的阶段
      delete sessionStore[sessionId];

      logger.info(`[TLDR Cancel] 用户 ${session.userId} 手动取消了会话 ${sessionId} (阶段: ${cancelledStage})。`);
      return '已成功取消当前的 tldr 总结任务。';
    });
  // --- 结束添加 cancel 命令 ---

  // --- 消息事件监听器 ---
  ctx.on('message', async (session: Session) => {
    // 1. 消息存储
    let prefix: string | undefined;
    if (typeof ctx.options.prefix === 'string') {
      prefix = ctx.options.prefix;
    } else if (Array.isArray(ctx.options.prefix) && ctx.options.prefix.length > 0 && typeof ctx.options.prefix[0] === 'string') {
      prefix = ctx.options.prefix[0];
    }
    const isCommand = prefix && session.content?.startsWith(prefix);
    const isBot = session.author?.isBot;
    const hasStorageInfo = !!(session.guildId && session.userId && session.messageId && session.content);

    if (hasStorageInfo && !isCommand && !isBot) {
      try {
        const username = session.author?.nick || session.author?.name || session.username || session.userId || 'UnknownUser';
        const timestamp = session.timestamp ? new Date(session.timestamp) : new Date();

        await ctx.database.create('tldr_messages', {
          messageId: session.messageId,
          guildId: session.guildId,
          userId: session.userId,
          username: username,
          content: session.content,
          timestamp: timestamp,
        });
      } catch (error) {
        logger.error(`[TLDR Store] 存储消息失败 (Guild: ${session.guildId}, MsgID: ${session.messageId}): ${error instanceof Error ? error.message : String(error)}`, error);
      }
    }

    // 2. TLDR 交互处理
    if (!session.guildId || !session.userId || !session.content) {
      return;
    }

    const sessionId = `${session.guildId}-${session.userId}`;
    const collectSession = sessionStore[sessionId];

    // --- 增加对 processing 状态的检查 ---
    if (!collectSession || collectSession.userId !== session.userId || collectSession.stage === 'completed' || collectSession.stage === 'processing') {
      return;
    }

    const botUserId = session.bot?.userId || ctx.bots[0]?.userId;
    const atBotRegex = botUserId ? new RegExp(`<at id="${botUserId}"[^>]*/>\\s*`) : null;
    const trimmedContent = atBotRegex ? session.content.replace(atBotRegex, '').trim() : session.content.trim();

    // --- 阶段 1: 等待【起点】消息回复 ---
    if (collectSession.stage === 'start') {
      if (trimmedContent === '1') {
        if (!session.quote || !session.quote.id) {
          logger.warn(`[TLDR Step 1] 用户 ${session.userId} (Session: ${sessionId}) 发送 '1' 但缺少引用信息或引用ID。`);
          if (collectSession.timer) clearTimeout(collectSession.timer);
          delete sessionStore[sessionId];
          await session.send('错误：无法识别您回复的【起点】消息。\n请确保您是【回复】目标消息，并且发送了数字【1】。\n可能原因：消息平台未能正确传递引用信息，或消息已被删除。\n\ntldr 任务已取消，请重新开始。').catch(e => logger.warn(`[TLDR Send Error] 发送引用缺失错误失败 for ${sessionId}: ${e.message}`));
          return;
        }

        const quotedMessageId = session.quote.id;
        try {
          const startMsgExists = await ctx.database.get('tldr_messages', { guildId: session.guildId, messageId: quotedMessageId });
          if (startMsgExists.length === 0) {
            logger.warn(`[TLDR Step 1] 引用的起点消息 (ID: ${quotedMessageId}) 在数据库中未找到 (Guild: ${session.guildId}).`);
            if (collectSession.timer) clearTimeout(collectSession.timer);
            delete sessionStore[sessionId];
            await session.send(`错误：引用的【起点】消息 (ID: ${quotedMessageId}) 未在数据库中找到。\n可能原因：消息过旧已被清理、从未被机器人记录。\n\ntldr 任务已取消，请重新开始。`).catch(e => logger.warn(`[TLDR Send Error] 发送DB未找到错误失败 for ${sessionId}: ${e.message}`));
            return;
          }
        } catch (dbError) {
          logger.error(`[TLDR Step 1] 检查起点消息数据库出错 (ID: ${quotedMessageId}, Guild: ${session.guildId}): ${dbError instanceof Error ? dbError.message : String(dbError)}`, dbError);
          if (collectSession.timer) clearTimeout(collectSession.timer);
          delete sessionStore[sessionId];
          await session.send('错误：检查引用的起点消息时数据库出错，tldr 任务已取消。请稍后再试或联系管理员。').catch(e => logger.warn(`[TLDR Send Error] 发送DB错误消息失败 for ${sessionId}: ${e.message}`));
          return;
        }

        if (collectSession.timer) clearTimeout(collectSession.timer); // 清除旧的超时定时器
        collectSession.firstMessageId = quotedMessageId;
        collectSession.stage = 'waitForSecond';

        // 重置定时器以进入下一步骤的超时
        if (config.commandTimeout > 0) {
          const timeoutSeconds = config.commandTimeout;
          const newTimerId = setTimeout(() => {
            const currentSession = sessionStore[sessionId];
            if (currentSession?.stage === 'waitForSecond') {
              logger.info(`[TLDR Timeout] 会话 ${sessionId} 在步骤2超时 (${timeoutSeconds}s) 已取消。`);
              delete sessionStore[sessionId];
              session.send('由于长时间未操作，tldr 总结任务已自动取消。').catch(err => logger.warn(`[TLDR Timeout] 发送步骤2超时取消消息失败 for ${sessionId}: ${err.message}`));
            }
          }, timeoutSeconds * 1000);
          collectSession.timer = newTimerId; // 存储新的定时器ID
        }

        try {
          await session.send('已记录起点消息。\n请【回复】你想要作为【总结终点】的那条消息，并发送数字【2】。\n如需中途取消，请发送 `tldr3 cancel`。'); // <--- 同样在这里提示可以取消
        } catch (sendError) {
          logger.warn(`[TLDR Send Error] 发送步骤2提示失败 for ${sessionId}: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
        }
        return;
      }
    }

    // --- 阶段 2: 等待【终点】消息回复 ---
    else if (collectSession.stage === 'waitForSecond') {
      if (trimmedContent === '2') {
        if (!collectSession.firstMessageId) {
          logger.error(`[TLDR Step 2 - Internal Error] 会话 ${sessionId} 缺少 firstMessageId。`);
          if (collectSession.timer) clearTimeout(collectSession.timer);
          delete sessionStore[sessionId];
          try { await session.send('内部错误：未记录起点消息，任务已取消，请重新开始。'); } catch (e) { logger.warn(`[TLDR Send Error] 发送内部错误消息失败: ${e.message}`); }
          return;
        }

        if (!session.quote || !session.quote.id) {
          logger.warn(`[TLDR Step 2] 用户 ${session.userId} (Session: ${sessionId}) 发送 '2' 但缺少引用信息或引用ID。`);
          if (collectSession.timer) clearTimeout(collectSession.timer);
          delete sessionStore[sessionId];
          await session.send('错误：无法识别您回复的【终点】消息。\n请确保您是【回复】目标消息，并且发送了数字【2】。\n可能原因：消息平台未能正确传递引用信息，或消息已被删除。\n\ntldr 任务已取消，请重新开始。').catch(e => logger.warn(`[TLDR Send Error] 发送引用缺失错误失败 for ${sessionId}: ${e.message}`));
          return;
        }

        const quotedMessageId = session.quote.id;
        try {
          const endMsgExists = await ctx.database.get('tldr_messages', { guildId: session.guildId, messageId: quotedMessageId });
          if (endMsgExists.length === 0) {
            logger.warn(`[TLDR Step 2] 引用的终点消息 (ID: ${quotedMessageId}) 在数据库中未找到 (Guild: ${session.guildId}).`);
            if (collectSession.timer) clearTimeout(collectSession.timer);
            delete sessionStore[sessionId];
            await session.send(`错误：引用的【终点】消息 (ID: ${quotedMessageId}) 未在数据库中找到。\n可能原因：消息过旧已被清理、从未被机器人记录，或来自其他群组。\n\ntldr 任务已取消，请重新开始或选择其他终点消息。`).catch(e => logger.warn(`[TLDR Send Error] 发送DB未找到错误失败 for ${sessionId}: ${e.message}`));
            return;
          }
        } catch (dbError) {
          logger.error(`[TLDR Step 2] 检查终点消息数据库出错 (ID: ${quotedMessageId}, Guild: ${session.guildId}): ${dbError instanceof Error ? dbError.message : String(dbError)}`, dbError);
          if (collectSession.timer) clearTimeout(collectSession.timer);
          delete sessionStore[sessionId];
          await session.send('错误：检查引用的终点消息时数据库出错，tldr 任务已取消。请稍后再试或联系管理员。').catch(e => logger.warn(`[TLDR Send Error] 发送DB错误消息失败 for ${sessionId}: ${e.message}`));
          return;
        }

        if (collectSession.timer) clearTimeout(collectSession.timer); // 处理开始前清除定时器
        collectSession.secondMessageId = quotedMessageId;
        collectSession.stage = 'processing'; // 进入处理中状态

        session.send(`已收到终点消息，正在获取消息记录并请求 AI 总结，请稍候... (这可能需要一点时间)`).catch(sendError => {
          logger.warn(`[TLDR Send Error] 发送处理中提示失败 for ${sessionId}: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
        });

        // --- 异步执行总结 ---
        // 将配置好的 logger 实例和 session 传递下去
        processMessagesFromDb(ctx, config, session, collectSession.firstMessageId, collectSession.secondMessageId, logger)
          .then(result => {
            const finalCheckSession = sessionStore[sessionId];
            // 只有在仍然是 processing 状态时才改为 completed，防止超时等情况干扰
            if (finalCheckSession?.stage === 'processing') {
              finalCheckSession.stage = 'completed'; // 标记为完成
            }
            session.send(result).catch(sendError => {
              logger.warn(`[TLDR Send Result Error] 发送总结结果失败 for session ${sessionId}: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
            });
          })
          .catch(error => {
            logger.error(`[TLDR Process Background Error] 处理会话 ${sessionId} 时发生意外错误: ${error instanceof Error ? error.message : String(error)}`, error);
            const errorCheckSession = sessionStore[sessionId];
            // 即使出错也标记为完成，防止用户卡住
            if (errorCheckSession?.stage === 'processing') {
              errorCheckSession.stage = 'completed';
            }
            session.send('处理总结时发生意外错误，任务已终止。').catch((e) => logger.warn(`[TLDR Send Error] 发送处理错误通知失败: ${e.message}`));
          })
          .finally(() => {
            // 增加一点延迟再清理会话状态，确保发送操作有机会完成
            const cleanupDelay = 500; // 0.5 秒延迟
            setTimeout(() => {
              // 再次检查会话是否存在再删除
              if (sessionStore[sessionId]) {
                // 不论是 completed 还是 processing (例如超时后又收到结果)，都清理掉
                delete sessionStore[sessionId];
              }
            }, cleanupDelay);
          });

        return; // 结束交互处理
      }
    }
  }); // 消息事件监听器结束

  // --- 定时清理旧消息 ---
  ctx.setInterval(async () => {
    if (config.maxMessageAgeDays <= 0) {
      return;
    }
    const cutoffDate = new Date(Date.now() - config.maxMessageAgeDays * Time.day);
    logger.info(`[TLDR Pruning] 开始自动清理早于 ${cutoffDate.toISOString()} 的消息记录...`);
    try {
      const query = { timestamp: { $lt: cutoffDate } };
      const result = await ctx.database.remove('tldr_messages', query);
      // Koishi v4 remove 返回 { matched, modified, upserted } 或 undefined
      // Koishi v3 remove 返回受影响行数
      // 这里简单记录操作完成即可
      logger.info(`[TLDR Pruning] 数据库清理操作已执行 (查询条件: timestamp < ${cutoffDate.toISOString()})。`);
    } catch (error) {
      logger.error(`[TLDR Pruning] 自动清理消息时出错: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  }, Time.hour); // 每小时执行一次

  logger.info('tldr3 插件已成功加载。');
} // apply 函数结束

/**
 * 核心: 从数据库获取消息、调用 AI 进行总结
 * @param ctx Koishi 上下文
 * @param config 插件配置
 * @param session 当前会话 (包含 bot 信息)
 * @param firstMsgId 起点消息 ID
 * @param secondMsgId 终点消息 ID
 * @param logger The logger instance configured with dynamic level
 * @returns 格式化后的总结结果或用户友好的错误信息
 */
async function processMessagesFromDb(
  ctx: Context,
  config: Config,
  session: Session,
  firstMsgId: string,
  secondMsgId: string,
  logger: Logger // 接收配置好的 logger
): Promise<string> {
  const guildId = session.guildId;
  const logPrefix = `[TLDR Process][Guild:${guildId}]`;

  if (!guildId) {
    logger.error(`${logPrefix} 错误：无法获取当前群组 ID。`);
    return '错误：无法获取当前群组 ID。';
  }
  if (!session.bot) {
    logger.error(`${logPrefix} 错误：无法获取机器人实例信息 (session.bot is undefined)。`);
    return '错误：无法获取机器人实例信息，无法进行总结。请确保机器人正常连接。';
  }
  // --- 确保获取机器人 selfId ---
  const botSelfId = session.bot.selfId;
  if (!botSelfId) {
    logger.error(`${logPrefix} 错误：无法获取机器人自身的 ID (session.bot.selfId is undefined)。`);
    return '错误：无法获取机器人自身 ID，无法确定其群昵称。';
  }
  // --- 结束获取 ---

  try {
    // 1. 查询起点和终点消息的时间戳
    const [startMsgArr, endMsgArr] = await Promise.all([
      ctx.database.get('tldr_messages', { guildId: guildId, messageId: firstMsgId }),
      ctx.database.get('tldr_messages', { guildId: guildId, messageId: secondMsgId })
    ]);

    if (startMsgArr.length === 0 || endMsgArr.length === 0) {
      let notFound: string[] = [];
      if (startMsgArr.length === 0) notFound.push("起点");
      if (endMsgArr.length === 0) notFound.push("终点");
      const missingIds = `${notFound.includes("起点") ? firstMsgId : ''} ${notFound.includes("终点") ? secondMsgId : ''}`.trim();
      logger.warn(`${logPrefix} ${notFound.join("和")}消息 (IDs: ${missingIds}) 在DB中未找到。`);
      return `错误：无法在数据库中找到引用的${notFound.join("和")}消息 (ID: ${missingIds})。\n它们可能已被清理、从未被记录或来自其他群组。`;
    }

    const startMsg = startMsgArr[0];
    const endMsg = endMsgArr[0];

    // 2. 确定时间范围
    const minTimestamp = startMsg.timestamp <= endMsg.timestamp ? startMsg.timestamp : endMsg.timestamp;
    const maxTimestamp = startMsg.timestamp >= endMsg.timestamp ? startMsg.timestamp : endMsg.timestamp;

    // 3. 查询范围内的所有消息 (按时间升序排序)
    const messagesToSummarize = await ctx.database.get('tldr_messages', {
      guildId: guildId,
      timestamp: { $gte: minTimestamp, $lte: maxTimestamp }
    }, { sort: { timestamp: 'asc' } as const });

    if (messagesToSummarize.length === 0) {
      logger.warn(`${logPrefix} 在 ${minTimestamp.toISOString()} 和 ${maxTimestamp.toISOString()} 之间未找到消息记录 (包含端点)。`);
      return '提示：在您选择的起点和终点消息之间（包括这两条消息）没有找到可供总结的消息记录。';
    }

    // --- 构建 UserID 到最新昵称的映射 ---
    const latestNicknames = new Map<string, string>();
    for (const msg of messagesToSummarize) {
      // 使用消息中存储的 username 作为当时的昵称
      if (msg.username && msg.username !== 'UnknownUser') {
        latestNicknames.set(msg.userId, msg.username);
      } else if (!latestNicknames.has(msg.userId)) {
        // 如果存储的是无效昵称，且未记录过此用户ID，则用ID备用
        latestNicknames.set(msg.userId, msg.userId);
      }
      // 如果存储无效但已有记录，则保留之前有效的昵称
    }
    // --- 结束构建映射 ---

    // 4. 格式化消息供 AI 处理 (使用 latestNicknames)
    let totalLength = 0;
    const formattedLines: string[] = [];
    for (const msg of messagesToSummarize) {
      let textContent = '';
      try {
        // 解析消息内容（h.parse 和 fallback 正则）
        const elements = h.parse(msg.content || '');
        textContent = elements.map(el => {
          if (el.type === 'text') return el.attrs.content || '';
          if (el.type === 'at') {
            const nameAttr = el.attrs.name || el.attrs.nickname;
            return nameAttr ? `@${nameAttr}` : `<at id="${el.attrs.id}"/>`;
          }
          if (el.type === 'img' || el.type === 'image') return '[图片]';
          if (el.type === 'face') return `[表情:${el.attrs.id || el.attrs.name || '未知'}]`;
          if (el.type === 'record' || el.type === 'video' || el.type === 'audio') return '[语音/视频]';
          return '';
        }).join('');
      } catch (parseError) {
        logger.warn(`${logPrefix} 解析消息内容失败 (h.parse) for DB record ${msg.id} (MsgID: ${msg.messageId}): ${parseError instanceof Error ? parseError.message : String(parseError)}. 使用后备正则方法。`);
        textContent = String(msg.content || '')
          .replace(/<img.*?\/?>|\[CQ:image,.*?\]/g, '[图片]')
          .replace(/<face id="([^"]*)"[^>]*>|\[CQ:face,id=(\d+).*?\]/g, (match, p1, p2) => `[表情:${p1 || p2 || '未知'}]`)
          .replace(/<at id="[^"]*?" name="([^"]*)"[^>]*>|\[CQ:at,qq=\d+,name=([^\]]+).*?\]/g, (match, p1, p2) => `@${p1 || p2}`)
          .replace(/<at id="([^"]*)"[^>]*>|\[CQ:at,qq=(\d+).*?\]/g, (match, p1, p2) => `<at id="${p1 || p2}"/>`)
          .replace(/<record.*?\/?>|\[CQ:(?:record|video|audio),.*?\]/g, '[语音/视频]')
          .replace(/<[^>]+>/g, '');
      }

      // --- 使用 latestNicknames 中的昵称 ---
      const senderNickname = latestNicknames.get(msg.userId) || msg.userId || 'UnknownUser';
      // --- 结束使用 ---

      const line = `${senderNickname}: ${textContent.trim()}`; // 使用查找到的最新昵称
      formattedLines.push(line);
      totalLength += line.length + 1; // +1 for newline
    }
    const formattedMessages = formattedLines.join('\n');

    // 5. 检查总长度限制
    if (totalLength > config.Textlimit) {
      logger.warn(`${logPrefix} 消息内容过长 (${totalLength} > ${config.Textlimit})，无法总结。`);
      return `总结失败：选择的消息内容总长度过长 (约 ${totalLength} 字符，已超出 ${config.Textlimit} 字符的限制)。请尝试选择更小的消息范围。`;
    }

    // 6. 调用 OpenAI API
    logger.info(`${logPrefix} 调用 OpenAI API 进行总结... (模型: ${config.openaiModel}, 消息数: ${messagesToSummarize.length}, 长度: ${totalLength})`);

    // --- 获取机器人名字，优先使用群昵称 ---
    let botGuildNickname: string | undefined = undefined;
    try {
      // 尝试获取机器人在当前群组的成员信息
      const botMemberInfo = await session.bot.getGuildMember(guildId, botSelfId);
      botGuildNickname = botMemberInfo?.nick; // 获取群昵称
      logger.debug(`${logPrefix} 成功获取机器人的群成员信息，群昵称: ${botGuildNickname}`);
    } catch (error) {
      logger.warn(`${logPrefix} 获取机器人 (${botSelfId}) 在群 (${guildId}) 的成员信息失败: ${error instanceof Error ? error.message : String(error)}。将回退使用全局昵称或ID。`);
    }

    // 构建机器人名字的回退链，优先使用获取到的群昵称
    const botName = botGuildNickname             // 1. 优先尝试机器人的群昵称
      || session.bot.user?.nick     // 2. 回退到机器人的全局昵称
      || session.bot.user?.name     // 3. 回退到机器人的全局用户名
      || botSelfId                  // 4. 回退到机器人自身的 ID
      || '机器人助手';               // 5. 最终的兜底名称
    // --- 结束获取机器人名字 ---

    const resolvedSystemPrompt = config.openaiSystemPrompt.replace(/{bot_name}/g, botName);
    logger.debug(`${logPrefix} 将用于替换 {bot_name} 的最终机器人名称: ${botName}`);
    logger.debug(`${logPrefix} 使用的 System Prompt (已替换占位符): ${resolvedSystemPrompt}`);

    try {
      const requestPayload = {
        model: config.openaiModel,
        messages: [
          { role: 'system', content: resolvedSystemPrompt }, // 使用包含正确 botName 的 prompt
          { role: 'user', content: formattedMessages } // 使用基于 latestNicknames 格式化的消息
        ],
        temperature: 0.5,
        // max_tokens: 1000, // 可选
      };

      logger.debug(`${logPrefix} OpenAI Request Payload: %o`, requestPayload);

      const startTime = Date.now();
      const response = await axios.post(
        config.openaiEndpoint,
        requestPayload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.openaiApiKey}`
          },
          timeout: 90000 // 90 秒超时
        }
      );
      const duration = Date.now() - startTime;
      logger.info(`${logPrefix} OpenAI API 调用成功 (耗时: ${duration}ms)。`);

      // 增加对响应结构的健壮性检查
      const summary = response?.data?.choices?.[0]?.message?.content;

      if (typeof summary !== 'string' || summary.trim().length === 0) {
        logger.error(`${logPrefix} OpenAI API 返回数据格式错误或总结内容为空。Status: ${response?.status}, Data: %o`, response?.data);
        return '总结失败：AI 服务返回的数据格式不正确或未能生成有效的总结内容。请检查 API 端点或联系管理员。';
      }

      // 7. 格式化并返回成功结果
      const finalResult = `【太长不看】消息总结 (基于 ${messagesToSummarize.length} 条消息)：\n--------------------\n${summary.trim()}`;
      return finalResult;

    } catch (apiError: any) {
      logger.error(`${logPrefix} 调用 OpenAI API 时出错: ${apiError?.message || apiError}`, apiError);
      let userErrorMessage = `总结失败: 调用 AI 服务时遇到错误。`;

      if (axios.isAxiosError(apiError)) {
        if (apiError.response) {
          const status = apiError.response.status;
          const data = apiError.response.data;
          const errorInfo = data?.error;
          const errorMsg = errorInfo?.message || (typeof data === 'string' ? data.substring(0, 150) : JSON.stringify(data).substring(0, 150));
          let detail = `状态码 ${status}.`;
          if (status === 401) detail = 'API 密钥无效或权限不足 (Unauthorized)。请检查配置。';
          else if (status === 429) detail = '请求过于频繁或超出配额 (Too Many Requests)。请稍后再试或检查账户状态。';
          else if (status === 400) detail = `请求格式错误、内容不当或模型不支持 (Bad Request${errorMsg ? ': ' + errorMsg : ''})。请检查配置和消息内容。`;
          else if (status === 404) detail = `API 端点未找到或模型名称错误 (Not Found)。请检查 OpenAI Endpoint 和 Model 配置。`;
          else if (status >= 500) detail = `AI 服务端内部错误 (Server Error${errorMsg ? ': ' + errorMsg : ''})。请稍后再试。`;
          else if (errorMsg) detail = `错误 ${status}: ${errorMsg}`;
          userErrorMessage = `总结失败: 请求 AI 服务出错 (${detail})`;
        } else if (apiError.request) {
          userErrorMessage = `总结失败: 请求 AI 服务超时或网络连接中断 (${apiError.code || 'No Response'})。请检查网络连接和 API 端点。`;
        } else {
          userErrorMessage = `总结失败: 准备请求 AI 服务时发生内部错误 (${apiError.message})。`;
        }
      } else {
        userErrorMessage = `总结失败: 处理 AI 请求时发生未知内部错误 (${apiError?.message || 'Unknown Error'})。`;
      }
      logger.error(`${logPrefix} OpenAI API Error Details: Status=${apiError.response?.status}, Code=${apiError.code}, Data=${JSON.stringify(apiError.response?.data)}`);
      return userErrorMessage;
    }

  } catch (dbError: any) {
    const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
    logger.error(`${logPrefix} 处理消息时数据库出错: ${errorMessage}`, dbError);
    return `总结失败: 查询消息记录时数据库出错 (${errorMessage})。请联系管理员检查日志。`;
  }
} // processMessagesFromDb 函数结束

// --- END OF FILE index.ts ---
import pino from 'pino';

// Create logger configuration based on environment
const createLogger = () => {
    const isDevelopment = process.env.NODE_ENV !== 'production';

    const config = {
        level: process.env.LOG_LEVEL || 'info',
        formatters: {
            level: (label) => {
                return { level: label };
            },
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        ...(isDevelopment && {
            transport: {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname',
                },
            },
        }),
    };

    return pino(config);
};

export default createLogger();

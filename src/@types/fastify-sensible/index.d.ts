import { FastifyPluginCallback } from 'fastify';

declare module 'fastify-sensible' {
  const fastifySensible: FastifyPluginCallback;
  export = fastifySensible;
}

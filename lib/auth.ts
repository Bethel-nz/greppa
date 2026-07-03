import { type BetterAuthOptions, betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { apiKey } from '@better-auth/api-key'
import { customSession, jwt, username } from 'better-auth/plugins'
import { drizzle, schema } from './db'
import { loadAuthConfig } from './auth-config'

const cfg = loadAuthConfig()

const regex = /^[a-zA-Z0-9_.#]{3,30}$/

const authConfig = {
  appName: 'Greppa',
  database: drizzleAdapter(drizzle, {
    provider: 'pg',
    schema,
    camelCase: true,
  }),
  secret: cfg.secret,
  baseURL: cfg.baseUrl,
  basePath: '/api/v1/auth',
  trustedOrigins: cfg.trustedOrigins,

  advanced: {
    cookiePrefix: 'greppa',
    useSecureCookies: cfg.baseUrl.startsWith('https://'),
    defaultCookieAttributes: {
      httpOnly: true,
      secure: cfg.baseUrl.startsWith('https://'),
      sameSite: 'lax',
    },
    database: {
      generateId: false,
    },
  },

  socialProviders: cfg.google
    ? {
        google: {
          clientId: cfg.google.clientId,
          clientSecret: cfg.google.clientSecret,
          mapProfileToUser(profile) {
            return {
              id: profile.sub,
              email: profile.email,
              firstName: profile.given_name,
              lastName: profile.family_name,
              image: profile.picture,
              username: profile.email.split('@')[0],
              emailVerified: profile.email_verified,
            }
          },
        },
      }
    : undefined,

  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ['google', 'email'],
    },
  },

  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },

  user: {
    fields: {
      email: 'email',
      name: 'name',
      image: 'image',
      emailVerified: 'email_verified',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    additionalFields: {
      username: {
        type: 'string',
        required: true,
      },
      firstName: {
        type: 'string',
        required: false,
        defaultValue: '',
      },
      lastName: {
        type: 'string',
        required: false,
        defaultValue: '',
      },
      role: {
        type: 'string',
        required: true,
        defaultValue: 'user',
        input: false,
      },
      bio: {
        type: 'string',
        required: false,
        defaultValue: '',
        input: false,
      },
      deletedAt: {
        type: 'string',
        required: false,
        defaultValue: '',
        input: false,
      },
      userProfileStep: {
        type: 'string',
        required: true,
        defaultValue: 'signup',
        input: false,
      },
    },
  },

  plugins: [
    customSession(async ({ user, session }) => {
      const u = user as typeof user & {
        username: string
        firstName: string
        lastName: string
        role: string
        bio: string
        deletedAt: string
        userProfileStep: string
      }
      return {
        user: {
          id: u.id,
          email: u.email,
          name: u.name,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          image: u.image,
          role: u.role,
          emailVerified: u.emailVerified,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
          userProfileStep: u.userProfileStep,
        },
        session,
      }
    }),
    jwt({
      jwt: {
        audience: cfg.baseUrl,
        issuer: cfg.baseUrl,
        expirationTime: '1h',
        definePayload({ user }) {
          return {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            image: user.image,
            username: user.username,
            emailVerified: user.emailVerified,
            profileStep: user.userProfileStep,
          }
        },
      },
    }),
    apiKey({
      apiKeyHeaders: 'x-api-key',
      enableSessionForAPIKeys: true,
      rateLimit: {
        enabled: true,
        timeWindow: 60_000,
        maxRequests: 120,
      },
    }),
    username({
      usernameValidator: (username) => {
        return regex.test(username)
      },
    }),
  ],

  databaseHooks: {
    user: {
      create: {
        before: async (user, _ctx) => {
          const [firstName, ...lastNameParts] = (user.name || '').split(' ')
          return {
            data: {
              ...user,
              firstName: firstName ?? '',
              lastName: lastNameParts.join(' '),
              username: user.email.split('@')[0],
            },
          }
        },
      },
    },
  },
} satisfies BetterAuthOptions

const auth = betterAuth(authConfig)
export { auth }
export type Auth = typeof auth

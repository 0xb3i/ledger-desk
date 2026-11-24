-- 订阅的管理链接（续费页、控制台），选填；只允许不含账号密码的 http(s) 地址，由服务端校验。
ALTER TABLE subscriptions ADD COLUMN url TEXT NOT NULL DEFAULT '' CHECK(length(url) <= 2000);

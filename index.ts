
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return reply({ error: "Method not allowed" }, 405);
  }

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(url, serviceKey);
    const body = await req.json();
    const action = body.action;

    // قائمة أسماء الحسابات النشطة فقط لعرضها في شاشة الدخول
    if (action === "list_login_users") {
      const { data: users, error } = await adminClient
        .from("profiles")
        .select("username")
        .eq("is_active", true)
        .in("role", ["admin", "employee"])
        .not("username", "is", null)
        .order("username", { ascending: true });
      if (error) return reply({ error: "تعذر تحميل قائمة الحسابات" }, 400);
      return reply({
        success: true,
        users: (users || []).filter((u) => !!u.username).map((u) => ({ username: u.username })),
      });
    }

    // تسجيل الدخول باسم المستخدم
    if (action === "login") {
      const username = String(body.username || "").trim();
      const password = String(body.password || "");

      if (!/^[a-zA-Z0-9.-]{3,32}$/.test(username) || !password) {
        return reply({ error: "بيانات الدخول غير صحيحة" }, 400);
      }

      const { data: profile, error } = await adminClient
        .from("profiles")
        .select("id, username, is_active, role")
        .ilike("username", username)
        .maybeSingle();

      if (error || !profile || !profile.is_active) {
        return reply({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" }, 401);
      }

      const email = username.toLowerCase() + "@pointage-mehira.local";
      const client = createClient(url, anonKey);

      const { data, error: loginError } =
        await client.auth.signInWithPassword({ email, password });

      if (loginError || !data.session) {
        return reply({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" }, 401);
      }

      return reply({
        success: true,
        user: data.user,
        session: data.session,
      });
    }

    // التحقق من هوية المستخدم في بقية العمليات
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return reply({ error: "غير مصرح" }, 401);
    }

    const client = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userError } =
      await client.auth.getUser();

    if (userError || !userData.user) {
      return reply({ error: "جلسة غير صالحة" }, 401);
    }

    const currentUser = userData.user;

    // تغيير المستخدم لكلمة مروره بنفسه
    if (action === "change_password") {
      const currentPassword = String(body.current_password || "");
      const password = String(body.password || "");
      if (!currentPassword) {
        return reply({ error: "أدخل كلمة المرور الحالية للتحقق من هويتك" }, 400);
      }
      if (password.length < 8) {
        return reply({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" }, 400);
      }
      if (!currentUser.email) {
        return reply({ error: "تعذر تحديد بريد حسابك للتحقق من كلمة المرور الحالية" }, 400);
      }

      // Verify the current password in a separate client so the active user's session is not replaced.
      const verifyClient = createClient(url, anonKey);
      const { error: verifyError } = await verifyClient.auth.signInWithPassword({
        email: currentUser.email,
        password: currentPassword,
      });
      if (verifyError) {
        return reply({ error: "كلمة المرور الحالية غير صحيحة" }, 401);
      }

      // Update through the authenticated user's own Auth endpoint.
      // The bearer token identifies the account; no user ID is accepted from the request.
      const updateResponse = await fetch(`${url}/auth/v1/user`, {
        method: "PUT",
        headers: {
          apikey: anonKey,
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });

      if (!updateResponse.ok) {
        return reply({ error: "تعذر تغيير كلمة المرور" }, 400);
      }

      return reply({ success: true });
    }

    // العمليات التالية للمدير فقط
    const { data: manager } = await adminClient
      .from("profiles")
      .select("role, is_active")
      .eq("id", currentUser.id)
      .maybeSingle();

    if (!manager || manager.role !== "admin" || !manager.is_active) {
      return reply({ error: "هذه العملية متاحة للمدير فقط" }, 403);
    }

    // إنشاء حساب عامل
    if (action === "create_worker") {
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const employeeId = body.employee_id || null;
      const permissions = body.permissions || {};
      const { data: employee, error: employeeError } = await adminClient
        .from("employees")
          .select("full_name")
            .eq("id", employeeId)
              .maybeSingle();

              if (employeeError || !employee) {
                return reply({ error: employeeError?.message || "العامل غير موجود" }, 400);
                }

      if (!/^[a-zA-Z0-9.-]{3,32}$/.test(username)) {
        return reply({ error: "اسم المستخدم غير صالح" }, 400);
      }

      if (password.length < 8) {
        return reply({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" }, 400);
      }

      const email = username.toLowerCase() + "@pointage-mehira.local";

      const { data: created, error: createError } =
        await adminClient.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { username },
        });

      if (createError || !created.user) {
        return reply({ error: "تعذر إنشاء الحساب. تحقق من اسم المستخدم" }, 400);
      }

      const { error: profileError } = await adminClient
        .from("profiles")
        .insert({
          id: created.user.id,
          full_name: employee.full_name,
          username,
          role: "employee",
          employee_id: employeeId,
          permissions,
          is_active: true,
        });

      if (profileError) {
  await adminClient.auth.admin.deleteUser(created.user.id);
  return reply({
    error: profileError.message || "تعذر إنشاء ملف العامل",
    code: profileError.code || null,
    details: profileError.details || null,
    hint: profileError.hint || null
  }, 400);
}

      return reply({ success: true, user_id: created.user.id });
    }

    // إعادة تعيين كلمة مرور عامل
    if (action === "reset_password") {
      const targetId = String(body.user_id || "");
      const password = String(body.password || "");

      if (!targetId || password.length < 8) {
        return reply({ error: "بيانات غير مكتملة أو كلمة مرور قصيرة" }, 400);
      }

      const { error } = await adminClient.auth.admin.updateUserById(
        targetId,
        { password }
      );

      if (error) return reply({ error: "تعذر إعادة تعيين كلمة المرور" }, 400);
      return reply({ success: true });
    }

    // تعطيل حساب عامل أو إعادة تفعيله
    if (action === "set_active") {
      const targetId = String(body.user_id || "");
      const active = body.active === true;

      if (!targetId || targetId === currentUser.id) {
        return reply({ error: "لا يمكن تنفيذ العملية على هذا الحساب" }, 400);
      }

      const { data: target } = await adminClient
        .from("profiles")
        .select("id, role")
        .eq("id", targetId)
        .maybeSingle();

      if (!target || target.role === "admin") {
        return reply({ error: "حساب العامل غير موجود" }, 404);
      }

      const { error: authError } =
        await adminClient.auth.admin.updateUserById(targetId, {
          ban_duration: active ? "none" : "876000h",
        });

      if (authError) return reply({ error: "تعذر تحديث حالة الحساب" }, 400);

      const { error: profileError } = await adminClient
        .from("profiles")
        .update({ is_active: active })
        .eq("id", targetId);

      if (profileError) {
        return reply({ error: "تعذر تحديث ملف العامل" }, 400);
      }

      return reply({ success: true, is_active: active });
    }


    // حذف حساب دخول عامل معطّل فقط؛ لا نحذف ملف الموظف أو سجلاته
    if (action === "delete_account") {
      const targetId = String(body.user_id || "");
      if (!targetId || targetId === currentUser.id) return reply({ error: "لا يمكن حذف هذا الحساب" }, 400);
      const { data: target, error: targetError } = await adminClient.from("profiles").select("id, role, is_active").eq("id", targetId).maybeSingle();
      if (targetError || !target || target.role !== "employee") return reply({ error: "حساب العامل غير موجود" }, 404);
      if (target.is_active === true) return reply({ error: "يجب تعطيل الحساب قبل حذفه" }, 400);
      const { error: deleteError } = await adminClient.auth.admin.deleteUser(targetId);
      if (deleteError) return reply({ error: deleteError.message || "تعذر حذف حساب الدخول" }, 400);
      return reply({ success: true });
    }

    return reply({ error: "عملية غير معروفة" }, 400);

  } catch (_error) {
    return reply({ error: "حدث خطأ أثناء تنفيذ العملية" }, 500);
  }
});

import type { DesktopBridge } from "../../../contracts/desktop-bridge";
import { accessCoverCopy, type SandAccess } from "./model";

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=5537116
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=5421612
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=5544624 (sand-access-cover selector)
// Immutable root sha256: ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa

export interface AccessCoverProps {
  readonly access: SandAccess;
  readonly bridge: Pick<DesktopBridge, "openExternal">;
  readonly isVisible: boolean;
}

export function AccessCover({ access, bridge, isVisible }: AccessCoverProps) {
  if (!isVisible) return null;
  const copy = accessCoverCopy(access);
  return (
    <div className="sand-access-cover">
      <div className="sand-onboarding__landing">
        <h1 id="sand-access-cover-heading">DB Bot</h1>
        <p>Ваша команда помощников, которая всегда на связи и доводит работу до конца.</p>
        <div>
          <div>
            <div><span>{copy.title}</span><span>{copy.body}</span></div>
            {/* Кнопка, открывавшая `https://cursor.com/bot/onboarding`, убрана.
                В DB Bot Lite нет ни команды, ни учётной записи, ни платёжного
                тарифа: показывать пользователю «купить Ultra» здесь не о чем. */}
          </div>
        </div>
      </div>
    </div>
  );
}
